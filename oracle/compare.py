#!/usr/bin/env python3
"""Compare WaterStudio's engine with OWA-EPANET, the reference, on a set of networks.

For each .inp file this runs:
  * runepanet (OWA-EPANET, built from oracle/build.sh) -> binary .out
  * ws-parity (the Rust engine)                          -> full-precision JSON
and compares heads, demands and flows at every report step, matching elements by ID.

The .out file stores 32-bit floats, so agreement below about 1e-5 relative cannot be
seen through it; the tolerances below sit above that floor.

Usage: compare.py --epanet DIR --engine BIN [--json report.json] file.inp ...
DIR holds bin/runepanet and lib/libepanet-output.so.
"""

import argparse
import ctypes
import json
import math
import os
import subprocess
import sys
import tempfile

# Initial parity tolerances (see the plan's "Verification" section).
HEAD_ATOL_FT = 1e-3          # 0.001 ft, converted to metres for SI networks
FLOW_RTOL = 1e-4             # 0.01 % of the larger flow magnitude...
FLOW_ATOL_FLOOR = 1e-3       # ...or this, in the network's flow units, near zero flow
TIMEOUT_S = 300

ENR_NODE, ENR_LINK = 1, 2
ENR_DEMAND, ENR_HEAD = 1, 2
ENR_FLOW = 1
ENR_PRESS_UNITS = 2
ENR_REPORT_START, ENR_REPORT_STEP, ENR_NUM_PERIODS = 1, 2, 4
SI_PRESSURE = {1, 2}  # metres, kPa


class OutFile:
    """Thin ctypes wrapper over OWA-EPANET's output-file reader."""

    def __init__(self, lib, path):
        self.lib = lib
        self.h = ctypes.c_void_p()
        self._check(lib.ENR_init(ctypes.byref(self.h)))
        self._check(lib.ENR_open(self.h, path.encode()))

    def _check(self, code):
        if code >= 400:
            raise RuntimeError(f"ENR error {code}")

    def close(self):
        self.lib.ENR_close(ctypes.byref(self.h))

    def size(self):
        arr, dim = ctypes.POINTER(ctypes.c_int)(), ctypes.c_int()
        self._check(self.lib.ENR_getNetSize(self.h, ctypes.byref(arr), ctypes.byref(dim)))
        out = [arr[i] for i in range(dim.value)]
        self.lib.ENR_free(ctypes.byref(arr))
        return {"nodes": out[0], "tanks": out[1], "links": out[2]}

    def time(self, which):
        v = ctypes.c_int()
        self._check(self.lib.ENR_getTimes(self.h, which, ctypes.byref(v)))
        return v.value

    def units(self, which):
        v = ctypes.c_int()
        self._check(self.lib.ENR_getUnits(self.h, which, ctypes.byref(v)))
        return v.value

    def name(self, kind, index):
        buf, n = ctypes.c_char_p(), ctypes.c_int()
        self._check(self.lib.ENR_getElementName(self.h, kind, index, ctypes.byref(buf), ctypes.byref(n)))
        name = buf.value.decode()
        self.lib.ENR_free(ctypes.byref(buf))
        return name

    def attribute(self, kind, period, attr):
        arr, n = ctypes.POINTER(ctypes.c_float)(), ctypes.c_int()
        fn = self.lib.ENR_getNodeAttribute if kind == ENR_NODE else self.lib.ENR_getLinkAttribute
        self._check(fn(self.h, period, attr, ctypes.byref(arr), ctypes.byref(n)))
        vals = [arr[i] for i in range(n.value)]
        self.lib.ENR_free(ctypes.byref(arr))
        return vals


def load_lib(epanet_dir):
    lib = ctypes.CDLL(os.path.join(epanet_dir, "lib", "libepanet-output.so"))
    lib.ENR_open.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    for f in ("ENR_getNetSize", "ENR_getTimes", "ENR_getUnits", "ENR_getElementName",
              "ENR_getNodeAttribute", "ENR_getLinkAttribute"):
        getattr(lib, f).argtypes = None
    lib.ENR_getNetSize.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    lib.ENR_getTimes.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    lib.ENR_getUnits.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    lib.ENR_getElementName.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                       ctypes.c_void_p, ctypes.c_void_p]
    lib.ENR_getNodeAttribute.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_void_p, ctypes.c_void_p]
    lib.ENR_getLinkAttribute.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                         ctypes.c_void_p, ctypes.c_void_p]
    return lib


def with_accuracy(inp, accuracy, work):
    """Copy a network with its [OPTIONS] ACCURACY replaced, so both engines solve to
    the same tight tolerance and what remains is algorithmic, not stopping-point noise."""
    with open(inp, encoding="latin-1") as f:
        lines = f.read().splitlines()
    out, section, done = [], "", False
    for line in lines:
        s = line.strip()
        if s.startswith("["):
            if section == "[OPTIONS]" and not done:
                out.append(f" Accuracy {accuracy}")
                done = True
            section = s.split("]")[0].upper() + "]"
        elif section == "[OPTIONS]" and s.upper().startswith("ACCURACY"):
            out.append(f" Accuracy {accuracy}")
            done = True
            continue
        out.append(line)
    if not done:
        out += ["[OPTIONS]", f" Accuracy {accuracy}"]
    path = os.path.join(work, "acc_" + os.path.basename(inp))
    with open(path, "w", encoding="latin-1") as f:
        f.write("\n".join(out) + "\n")
    return path


def compare_one(inp, args, lib, work):
    original = inp
    if args.accuracy:
        inp = with_accuracy(inp, args.accuracy, work)
    base = os.path.splitext(os.path.basename(inp))[0]
    out_path = os.path.join(work, base + ".out")
    rpt_path = os.path.join(work, base + ".rpt")
    js_path = os.path.join(work, base + ".json")
    row = {"network": original, "status": "ok"}

    try:
        ref = subprocess.run([os.path.join(args.epanet, "bin", "runepanet"), inp, rpt_path, out_path],
                             capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {**row, "status": "reference-timeout"}
    if ref.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        return {**row, "status": "reference-failed"}

    try:
        eng = subprocess.run([args.engine, inp, js_path], capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {**row, "status": "engine-timeout"}
    if eng.returncode != 0:
        msg = eng.stderr.decode(errors="replace").strip().splitlines()
        return {**row, "status": "engine-failed", "detail": (msg[-1] if msg else "")[:160]}
    with open(js_path) as f:
        rs = json.load(f)

    out = OutFile(lib, out_path)
    try:
        size = out.size()
        si = out.units(ENR_PRESS_UNITS) in SI_PRESSURE
        head_atol = HEAD_ATOL_FT * (0.3048 if si else 1.0)
        start, step, periods = (out.time(ENR_REPORT_START), out.time(ENR_REPORT_STEP),
                                out.time(ENR_NUM_PERIODS))
        nodes = [out.name(ENR_NODE, i + 1) for i in range(size["nodes"])]
        links = [out.name(ENR_LINK, i + 1) for i in range(size["links"])]
        rs_node = {n: i for i, n in enumerate(rs["nodes"])}
        rs_link = {n: i for i, n in enumerate(rs["links"])}
        missing = [n for n in nodes if n not in rs_node] + [l for l in links if l not in rs_link]
        if missing:
            return {**row, "status": "id-mismatch", "detail": ", ".join(missing[:5])}

        worst = {"head": (0.0, None), "demand": (0.0, None), "flow": (0.0, None)}
        fails = {"head": 0, "demand": 0, "flow": 0}
        compared = 0
        for p in range(periods):
            t = start + p * step
            if t % rs["report_step"]:
                return {**row, "status": "step-mismatch"}
            k = t // rs["report_step"]
            if k >= len(rs["heads"]):
                return {**row, "status": "short-result", "detail": f"engine has {len(rs['heads'])} steps"}
            ref_h = out.attribute(ENR_NODE, p, ENR_HEAD)
            ref_d = out.attribute(ENR_NODE, p, ENR_DEMAND)
            ref_q = out.attribute(ENR_LINK, p, ENR_FLOW)
            for i, n in enumerate(nodes):
                j = rs_node[n]
                for key, refv, rsv in (("head", ref_h[i], rs["heads"][k][j]),
                                       ("demand", ref_d[i], rs["demands"][k][j])):
                    tol = head_atol if key == "head" else max(FLOW_ATOL_FLOOR, FLOW_RTOL * abs(refv))
                    err = abs(rsv - refv)
                    if not math.isfinite(rsv):
                        err = math.inf
                    if err > worst[key][0]:
                        worst[key] = (err, f"{n} @ {t // 3600}:{t % 3600 // 60:02d}")
                    if err > tol:
                        fails[key] += 1
                compared += 1
            for i, l in enumerate(links):
                refv, rsv = ref_q[i], rs["flows"][k][rs_link[l]]
                tol = max(FLOW_ATOL_FLOOR, FLOW_RTOL * abs(refv))
                err = abs(rsv - refv) if math.isfinite(rsv) else math.inf
                if err > worst["flow"][0]:
                    worst["flow"] = (err, f"{l} @ {t // 3600}:{t % 3600 // 60:02d}")
                if err > tol:
                    fails["flow"] += 1
        row.update({
            "nodes": len(nodes), "links": len(links), "periods": periods,
            "solve_ms": round(rs.get("solve_ms", 0), 2),
            "max_head_err": worst["head"][0], "at_head": worst["head"][1],
            "max_demand_err": worst["demand"][0], "at_demand": worst["demand"][1],
            "max_flow_err": worst["flow"][0], "at_flow": worst["flow"][1],
            "fail_counts": fails,
        })
        if any(fails.values()):
            row["status"] = "out-of-tolerance"
    finally:
        out.close()
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epanet", required=True)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--json")
    ap.add_argument("--accuracy", type=float,
                    help="override ACCURACY in both engines (e.g. 1e-8) to compare converged solutions")
    ap.add_argument("networks", nargs="+")
    args = ap.parse_args()
    lib = load_lib(args.epanet)
    rows = []
    with tempfile.TemporaryDirectory() as work:
        for inp in args.networks:
            try:
                r = compare_one(inp, args, lib, work)
            except Exception as e:  # report and keep going: one bad file must not hide the rest
                r = {"network": inp, "status": "harness-error", "detail": str(e)[:160]}
            rows.append(r)
            short = os.path.relpath(inp)
            if r["status"] in ("ok", "out-of-tolerance"):
                print(f"{r['status']:17} {short}  head {r['max_head_err']:.2e} ({r['at_head']})  "
                      f"flow {r['max_flow_err']:.2e} ({r['at_flow']})  fails {r['fail_counts']}")
            else:
                print(f"{r['status']:17} {short}  {r.get('detail', '')}")
            sys.stdout.flush()
    ok = sum(r["status"] == "ok" for r in rows)
    print(f"\n{ok}/{len(rows)} networks within tolerance")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(rows, f, indent=1, default=str)
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
