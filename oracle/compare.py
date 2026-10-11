#!/usr/bin/env python3
"""Compare WaterStudio's engine with OWA-EPANET, the reference, on a set of networks.

For each .inp file this runs, each in its own process:
  * OWA-EPANET's toolkit (libepanet2 from oracle/build.sh) -> full-precision JSON
  * the engine under test (ws-parity or its WebAssembly wrapper) -> full-precision JSON
and compares heads, demands, flows and water quality at every report period, matching
elements by ID.

The reference is driven exactly as runepanet drives it (EN_openH, EN_initH saving the
hydraulics, EN_runH/EN_nextH to the end; then, when the network has a quality analysis,
EN_openQ, EN_initQ and EN_runQ/EN_nextQ over the saved hydraulics), and a report period
takes the first solution at or after its time, as EPANET's output file does. Values are read in double precision through
the toolkit rather than from the binary output file, which stores 32-bit floats and
would hide differences below about 1e-7 relative.

glibc picks an FMA-based pow/exp/log on CPUs that have FMA, so OWA-EPANET's results
depend on the machine. The reference is pinned to glibc's portable variants with
GLIBC_TUNABLES; the engine computes the same functions bit for bit (ADR 0003). A
network whose every value matches to the bit is reported as "exact".

Usage: compare.py --epanet DIR --engine BIN [--json report.json] file.inp ...
DIR holds lib/libepanet2.so.
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
QUAL_RTOL = 1e-4             # 0.01 % of the quality value...
QUAL_ATOL_FLOOR = 1e-3       # ...or this, in the network's quality units, near zero
TIMEOUT_S = 300

# Keep glibc on its portable pow/exp/log (see the module docstring).
TUNABLES = "glibc.cpu.hwcaps=-AVX2_Usable,-FMA_Usable,-AVX2,-FMA"

EN_NODECOUNT, EN_LINKCOUNT = 0, 2
EN_REPORTSTEP, EN_REPORTSTART = 5, 6
EN_DEMAND, EN_HEAD = 9, 10
EN_FLOW = 8
EN_QUALITY, EN_LINKQUAL = 12, 14
EN_SAVE = 1
SI_FLOW_UNITS = set(range(5, 11))  # LPS, LPM, MLD, CMH, CMD, CMS



def dump_reference(epanet_dir, inp, out_path):
    """Solve one network with OWA-EPANET's toolkit and write every report period."""
    lib = ctypes.CDLL(os.path.join(epanet_dir, "lib", "libepanet2.so"))
    ph = ctypes.c_void_p()
    lib.EN_createproject(ctypes.byref(ph))
    rpt = out_path + ".rpt"
    code = lib.EN_open(ph, inp.encode(), rpt.encode(), b"")
    if code > 100:
        json.dump({"error": f"EN_open error {code}"}, open(out_path, "w"))
        return
    nn, nl, units = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
    lib.EN_getcount(ph, EN_NODECOUNT, ctypes.byref(nn))
    lib.EN_getcount(ph, EN_LINKCOUNT, ctypes.byref(nl))
    lib.EN_getflowunits(ph, ctypes.byref(units))
    rstep, rstart = ctypes.c_long(), ctypes.c_long()
    lib.EN_gettimeparam(ph, EN_REPORTSTEP, ctypes.byref(rstep))
    lib.EN_gettimeparam(ph, EN_REPORTSTART, ctypes.byref(rstart))
    buf = ctypes.create_string_buffer(256)
    nodes, links = [], []
    for i in range(1, nn.value + 1):
        lib.EN_getnodeid(ph, i, buf)
        nodes.append(buf.value.decode("latin-1"))
    for i in range(1, nl.value + 1):
        lib.EN_getlinkid(ph, i, buf)
        links.append(buf.value.decode("latin-1"))
    res = {"nodes": nodes, "links": links, "si": units.value in SI_FLOW_UNITS,
           "report_start": rstart.value, "report_step": rstep.value,
           "times": [], "heads": [], "demands": [], "flows": [],
           "quality_times": [], "node_quality": [], "link_quality": []}
    v = ctypes.c_double()

    def node_values(code):
        out = []
        for i in range(1, nn.value + 1):
            lib.EN_getnodevalue(ph, i, code, ctypes.byref(v))
            out.append(v.value)
        return out

    def link_values(code):
        out = []
        for i in range(1, nl.value + 1):
            lib.EN_getlinkvalue(ph, i, code, ctypes.byref(v))
            out.append(v.value)
        return out

    code = lib.EN_openH(ph)
    if code <= 100:
        code = lib.EN_initH(ph, EN_SAVE)
    t, tstep = ctypes.c_long(), ctypes.c_long()
    rtime = rstart.value
    while code <= 100:
        code = lib.EN_runH(ph, ctypes.byref(t))
        if code > 100:
            break
        if t.value >= rtime:
            res["times"].append(t.value)
            res["heads"].append(node_values(EN_HEAD))
            res["demands"].append(node_values(EN_DEMAND))
            res["flows"].append(link_values(EN_FLOW))
            rtime += rstep.value
        code = lib.EN_nextH(ph, ctypes.byref(tstep))
        if tstep.value <= 0:
            break
    if code > 100:
        res["error"] = f"hydraulics error {code}"
    lib.EN_closeH(ph)
    qual_type, trace_node = ctypes.c_int(), ctypes.c_int()
    lib.EN_getqualtype(ph, ctypes.byref(qual_type), ctypes.byref(trace_node))
    if code <= 100 and qual_type.value != 0:
        code = lib.EN_openQ(ph)
        if code <= 100:
            code = lib.EN_initQ(ph, 0)
        rtime = rstart.value
        while code <= 100:
            code = lib.EN_runQ(ph, ctypes.byref(t))
            if code > 100:
                break
            if t.value >= rtime:
                res["quality_times"].append(t.value)
                res["node_quality"].append(node_values(EN_QUALITY))
                res["link_quality"].append(link_values(EN_LINKQUAL))
                rtime += rstep.value
            code = lib.EN_nextQ(ph, ctypes.byref(tstep))
            if tstep.value <= 0:
                break
        if code > 100:
            res["error"] = f"quality error {code}"
    with open(out_path, "w") as f:
        json.dump(res, f)


def run_reference(args, inp, path):
    env = dict(os.environ, GLIBC_TUNABLES=TUNABLES)
    cmd = [sys.executable, "-I", os.path.abspath(__file__), "--dump-reference",
           "--epanet", args.epanet, inp, path]
    return subprocess.run(cmd, capture_output=True, timeout=TIMEOUT_S, env=env)


def compare_one(inp, args, work):
    base = os.path.splitext(os.path.basename(inp))[0]
    ref_path = os.path.join(work, base + ".ref.json")
    js_path = os.path.join(work, base + ".json")
    row = {"network": inp, "status": "ok"}

    try:
        refp = run_reference(args, inp, ref_path)
    except subprocess.TimeoutExpired:
        return {**row, "status": "reference-timeout"}
    if refp.returncode != 0 or not os.path.exists(ref_path):
        msg = refp.stderr.decode(errors="replace").strip().splitlines()
        return {**row, "status": "reference-failed", "detail": (msg[-1] if msg else "")[:160]}
    with open(ref_path) as f:
        ref = json.load(f)
    if "error" in ref and not ref.get("times"):
        return {**row, "status": "reference-failed", "detail": ref["error"]}

    try:
        eng = subprocess.run([args.engine, inp, js_path], capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {**row, "status": "engine-timeout"}
    if eng.returncode != 0:
        msg = eng.stderr.decode(errors="replace").strip().splitlines()
        return {**row, "status": "engine-failed", "detail": (msg[-1] if msg else "")[:160]}
    with open(js_path) as f:
        rs = json.load(f)

    head_atol = HEAD_ATOL_FT * (0.3048 if ref["si"] else 1.0)
    nodes, links = ref["nodes"], ref["links"]
    rs_node = {n: i for i, n in enumerate(rs["nodes"])}
    rs_link = {n: i for i, n in enumerate(rs["links"])}
    missing = [n for n in nodes if n not in rs_node] + [l for l in links if l not in rs_link]
    if missing:
        return {**row, "status": "id-mismatch", "detail": ", ".join(missing[:5])}

    worst = {k: (0.0, None) for k in ("head", "demand", "flow", "quality")}
    fails = {k: 0 for k in ("head", "demand", "flow", "quality")}
    has_quality = bool(ref.get("quality_times"))
    if has_quality and len(rs.get("node_quality", [])) != len(ref["quality_times"]):
        return {**row, "status": "period-mismatch",
                "detail": f"reference {len(ref['quality_times'])} quality periods, "
                          f"engine {len(rs.get('node_quality', []))}"}
    inexact = 0
    total = 0
    for p, t in enumerate(ref["times"]):
        rel = t - rs.get("report_start", 0)
        if rel < 0 or rel % rs["report_step"]:
            return {**row, "status": "step-mismatch"}
        k = rel // rs["report_step"]
        if k >= len(rs["heads"]):
            return {**row, "status": "short-result", "detail": f"engine has {len(rs['heads'])} periods"}
        when = f"{t // 3600}:{t % 3600 // 60:02d}"
        checks = []
        for i, n in enumerate(nodes):
            j = rs_node[n]
            checks.append(("head", n, ref["heads"][p][i], rs["heads"][k][j]))
            checks.append(("demand", n, ref["demands"][p][i], rs["demands"][k][j]))
        for i, l in enumerate(links):
            checks.append(("flow", l, ref["flows"][p][i], rs["flows"][k][rs_link[l]]))
        if has_quality:
            # Quality periods are the hydraulic periods: both take the first solution at
            # or after each report time.
            if ref["quality_times"][p] != t:
                return {**row, "status": "step-mismatch", "detail": "quality periods differ"}
            for i, n in enumerate(nodes):
                checks.append(("quality", n, ref["node_quality"][p][i], rs["node_quality"][k][rs_node[n]]))
            for i, l in enumerate(links):
                checks.append(("quality", l, ref["link_quality"][p][i], rs["link_quality"][k][rs_link[l]]))
        for key, name, refv, rsv in checks:
            total += 1
            if rsv is None or not math.isfinite(rsv):
                err = math.inf
            else:
                err = abs(rsv - refv)
            if rsv != refv:
                inexact += 1
            if key == "head":
                tol = head_atol
            elif key == "quality":
                tol = max(QUAL_ATOL_FLOOR, QUAL_RTOL * abs(refv))
            else:
                tol = max(FLOW_ATOL_FLOOR, FLOW_RTOL * abs(refv))
            if err > worst[key][0]:
                worst[key] = (err, f"{name} @ {when}")
            if err > tol:
                fails[key] += 1
    if len(rs["heads"]) != len(ref["times"]):
        return {**row, "status": "period-mismatch",
                "detail": f"reference {len(ref['times'])} periods, engine {len(rs['heads'])}"}
    row.update({
        "nodes": len(nodes), "links": len(links), "periods": len(ref["times"]),
        "solve_ms": round(rs.get("solve_ms", 0), 2),
        "max_head_err": worst["head"][0], "at_head": worst["head"][1],
        "max_demand_err": worst["demand"][0], "at_demand": worst["demand"][1],
        "max_flow_err": worst["flow"][0], "at_flow": worst["flow"][1],
        "quality": has_quality,
        "max_quality_err": worst["quality"][0], "at_quality": worst["quality"][1],
        "fail_counts": fails, "values": total, "inexact_values": inexact,
        "exact": inexact == 0,
    })
    if "error" in ref:
        row.update({"status": "reference-failed", "detail": ref["error"]})
    elif any(fails.values()):
        row["status"] = "out-of-tolerance"
    return row


def main():
    if "--dump-reference" in sys.argv:
        ap = argparse.ArgumentParser()
        ap.add_argument("--dump-reference", action="store_true")
        ap.add_argument("--epanet", required=True)
        ap.add_argument("inp")
        ap.add_argument("out")
        a = ap.parse_args()
        dump_reference(a.epanet, a.inp, a.out)
        return 0
    ap = argparse.ArgumentParser()
    ap.add_argument("--epanet", required=True)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--json")
    ap.add_argument("networks", nargs="+")
    args = ap.parse_args()
    rows = []
    with tempfile.TemporaryDirectory() as work:
        for inp in args.networks:
            try:
                r = compare_one(inp, args, work)
            except Exception as e:  # report and keep going: one bad file must not hide the rest
                r = {"network": inp, "status": "harness-error", "detail": str(e)[:160]}
            rows.append(r)
            short = os.path.relpath(inp)
            if r["status"] in ("ok", "out-of-tolerance"):
                exact = "exact" if r["exact"] else f"{r['inexact_values']}/{r['values']} differ"
                print(f"{r['status']:17} {short}  {exact}  head {r['max_head_err']:.2e} ({r['at_head']})  "
                      f"flow {r['max_flow_err']:.2e} ({r['at_flow']})"
                      + (f"  quality {r['max_quality_err']:.2e} ({r['at_quality']})" if r["quality"] else "")
                      + f"  fails {r['fail_counts']}")
            else:
                print(f"{r['status']:17} {short}  {r.get('detail', '')}")
            sys.stdout.flush()
    ok = sum(r["status"] == "ok" for r in rows)
    exact = sum(bool(r.get("exact")) and r["status"] == "ok" for r in rows)
    print(f"\n{ok}/{len(rows)} networks within tolerance, {exact} bit-identical")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(rows, f, indent=1, default=str)
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
