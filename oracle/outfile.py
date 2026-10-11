#!/usr/bin/env python3
"""Compare WaterStudio's EPANET report and binary output files with OWA-EPANET's.

For each network, runs OWA-EPANET's `runepanet` (glibc pinned as in compare.py) and
`ws run`, and compares the two binary output files byte for byte and the two reports
line for line, with the run's clock time masked. When the output files differ, names
the first difference by section, variable, period and element.

usage: outfile.py --epanet DIR --engine WS_BIN [--json report.json] file.inp ...
"""

import argparse
import json
import os
import re
import struct
import subprocess
import sys
import tempfile

TUNABLES = "glibc.cpu.hwcaps=-AVX2_Usable,-FMA_Usable,-AVX2,-FMA"
TIMEOUT_S = 300
CTIME = re.compile(rb"[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}")
NODE_VARS = ["demand", "head", "pressure", "quality"]
LINK_VARS = ["flow", "velocity", "headloss", "quality", "status", "setting", "reaction", "friction"]


def layout(data):
    """Section boundaries of an output file, from its prolog counts."""
    nn, nt, nl, npump = struct.unpack_from("<4i", data, 8)
    prolog = 15 * 4 + 3 * 80 + 2 * 260 + 2 * 32 + 32 * (nn + nl) + 12 * nl + 8 * nt + 4 * nn + 8 * nl
    energy = 28 * npump + 4
    period = 4 * (4 * nn + 8 * nl)
    return nn, nl, prolog, energy, period


def locate(data, offset):
    nn, nl, prolog, energy, period = layout(data)
    if offset < prolog:
        return f"prolog byte {offset}"
    if offset < prolog + energy:
        return f"energy byte {offset - prolog}"
    rel = offset - prolog - energy
    nperiods = struct.unpack_from("<i", data, len(data) - 12)[0]
    if rel < nperiods * period:
        p, r = divmod(rel, period)
        f = r // 4
        if f < 4 * nn:
            v, i = divmod(f, nn)
            return f"period {p} node {i + 1} {NODE_VARS[v]}"
        v, k = divmod(f - 4 * nn, nl)
        return f"period {p} link {k + 1} {LINK_VARS[v]}"
    return f"epilog byte {rel - nperiods * period}"


def compare_one(inp, args, work):
    base = os.path.splitext(os.path.basename(inp))[0]
    ref, ours = os.path.join(work, base + ".ref.out"), os.path.join(work, base + ".out")
    ref_rpt, our_rpt = os.path.join(work, base + ".ref.rpt"), os.path.join(work, base + ".rpt")
    row = {"network": inp}
    env = dict(os.environ, GLIBC_TUNABLES=TUNABLES)
    for path in (ref, ours, ref_rpt, our_rpt):
        if os.path.exists(path):
            os.remove(path)
    try:
        subprocess.run([os.path.join(args.epanet, "bin", "runepanet"), inp, ref_rpt, ref],
                       capture_output=True, timeout=TIMEOUT_S, env=env)
    except subprocess.TimeoutExpired:
        return {**row, "status": "reference-timeout"}
    if not os.path.exists(ref) or os.path.getsize(ref) == 0:
        return {**row, "status": "reference-failed"}
    try:
        eng = subprocess.run([args.engine, "run", inp, our_rpt, ours],
                             capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return {**row, "status": "engine-timeout"}
    if eng.returncode != 0 or not os.path.exists(ours):
        msg = eng.stderr.decode(errors="replace").strip().splitlines()
        return {**row, "status": "engine-failed", "detail": (msg[-1] if msg else "")[:160]}
    details = []
    a, b = open(ref, "rb").read(), open(ours, "rb").read()
    if a != b:
        n = min(len(a), len(b))
        first = next((i for i in range(n) if a[i] != b[i]), n)
        words = sum(1 for i in range(0, n - 3, 4) if a[i:i + 4] != b[i:i + 4])
        detail = f".out: {words} words differ; first at {locate(a, first)}"
        if len(a) != len(b):
            detail += f"; sizes {len(a)} vs {len(b)}"
        details.append(detail)
    ra = CTIME.sub(b"<time>", open(ref_rpt, "rb").read()).split(b"\n")
    rb = CTIME.sub(b"<time>", open(our_rpt, "rb").read()).split(b"\n")
    if ra != rb:
        k = next((i for i in range(min(len(ra), len(rb))) if ra[i] != rb[i]), min(len(ra), len(rb)))
        want = ra[k].decode("latin-1") if k < len(ra) else "<end>"
        got = rb[k].decode("latin-1") if k < len(rb) else "<end>"
        details.append(f".rpt line {k + 1}: want {want.strip()!r} got {got.strip()!r}")
    if not details:
        return {**row, "status": "ok", "bytes": len(a)}
    return {**row, "status": "differs", "detail": "; ".join(details)}


def main():
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
            except Exception as e:  # keep going: one bad file must not hide the rest
                r = {"network": inp, "status": "harness-error", "detail": str(e)[:160]}
            rows.append(r)
            print(f"{r['status']:17} {os.path.relpath(inp)}  {r.get('detail', '')}")
            sys.stdout.flush()
    ok = sum(r["status"] == "ok" for r in rows)
    print(f"\n{ok}/{len(rows)} networks with identical reports and output files")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(rows, f, indent=1)
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
