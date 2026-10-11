#!/usr/bin/env python3
"""Compares WaterStudio's multi-species engine (`ws msx`) with EPA EPANET-MSX (`runepanetmsx`).

For each case (an EPANET input file and an MSX input file) both programs run in a scratch
directory; the binary results files must be identical byte for byte, and so must the MSX
part of the report. When the files differ, the largest difference over every node, link,
species and period is reported to help find the cause.

usage: msx.py --msx <runepanetmsx> --engine <ws> [--json out.json] [--jobs N] cases.txt
cases.txt: one case per line, "<net.inp> <net.msx>", paths relative to the file.
"""

import argparse
import concurrent.futures as cf
import json
import os
import struct
import subprocess
import sys
import tempfile
import time

# Keep glibc off its FMA code paths, as compare.py does (ADR 0003).
TUNABLES = "glibc.cpu.hwcaps=-AVX2_Usable,-FMA_Usable,-AVX2,-FMA"
MAGIC = 516114521


def read_out(path):
    """Parse an MSX binary results file into (species, nodes, links, periods, values)."""
    with open(path, "rb") as f:
        b = f.read()
    if len(b) < 40:
        raise ValueError("file too short")
    magic, _version, nn, nl, ns, _rstep = struct.unpack_from("<6i", b, 0)
    if magic != MAGIC:
        raise ValueError("bad magic number")
    pos = 24
    species = []
    for _ in range(ns):
        (n,) = struct.unpack_from("<i", b, pos)
        pos += 4
        species.append(b[pos : pos + n].decode("latin-1"))
        pos += n + 16
    offset, periods, _err, magic2 = struct.unpack_from("<4i", b, len(b) - 16)
    if magic2 != MAGIC:
        raise ValueError("file not closed")
    count = periods * (nn + nl) * ns
    values = struct.unpack_from(f"<{count}f", b, offset)
    return species, nn, nl, periods, values


def msx_section(path):
    """The MSX report: from its first page header to the end, minus EPANET's closing lines."""
    try:
        with open(path, encoding="latin-1") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        return None
    start = next((i for i, l in enumerate(lines) if "EPANET-MSX 2.0.0" in l), None)
    if start is None:
        return []
    return [l for l in lines[start:] if not l.strip().startswith("Analysis ended")]


def run_case(msx_bin, engine, inp, msx):
    name = f"{os.path.relpath(inp)} + {os.path.basename(msx)}"
    env = dict(os.environ, GLIBC_TUNABLES=TUNABLES)
    with tempfile.TemporaryDirectory() as tmp:
        results = {}
        for who, cmd in (("ref", [msx_bin]), ("ours", [engine, "msx"])):
            rpt, out = os.path.join(tmp, f"{who}.rpt"), os.path.join(tmp, f"{who}.bin")
            t0 = time.time()
            p = subprocess.run(cmd + [inp, msx, rpt, out], cwd=tmp, env=env, capture_output=True, text=True)
            results[who] = {"status": p.returncode, "rpt": rpt, "out": out, "seconds": round(time.time() - t0, 2),
                            "stderr": p.stderr.strip()[-500:]}
        r = {"case": name, "ref_seconds": results["ref"]["seconds"], "ours_seconds": results["ours"]["seconds"]}
        ref_ok = os.path.exists(results["ref"]["out"])
        ours_ok = os.path.exists(results["ours"]["out"])
        if not ref_ok or not ours_ok:
            r["result"] = "error"
            r["detail"] = f"reference output {'present' if ref_ok else 'missing'}, ours {'present' if ours_ok else 'missing'}; {results['ours']['stderr']}"
            return r
        with open(results["ref"]["out"], "rb") as a, open(results["ours"]["out"], "rb") as b:
            same_bin = a.read() == b.read()
        same_rpt = msx_section(results["ref"]["rpt"]) == msx_section(results["ours"]["rpt"])
        if same_bin and same_rpt:
            r["result"] = "identical"
            return r
        r["result"] = "differs"
        detail = []
        if not same_bin:
            try:
                sa, nn, nl, pa, va = read_out(results["ref"]["out"])
                sb, nn2, nl2, pb, vb = read_out(results["ours"]["out"])
                if (sa, nn, nl, pa) != (sb, nn2, nl2, pb):
                    detail.append(f"layout differs: {pa} vs {pb} periods")
                else:
                    worst = max(range(len(va)), key=lambda i: abs(va[i] - vb[i]), default=None)
                    if worst is not None:
                        d = abs(va[worst] - vb[worst])
                        rel = d / max(abs(va[worst]), 1e-30)
                        detail.append(f"max |diff| {d:.3g} (rel {rel:.3g}) at value {worst}: {va[worst]!r} vs {vb[worst]!r}")
                    else:
                        detail.append("binary files differ outside the results")
            except ValueError as e:
                detail.append(f"cannot parse output: {e}")
        if not same_rpt:
            a, b = msx_section(results["ref"]["rpt"]) or [], msx_section(results["ours"]["rpt"]) or []
            i = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
            detail.append(f"report differs at line {i + 1}: {a[i] if i < len(a) else '<end>'!r} vs {b[i] if i < len(b) else '<end>'!r}")
        r["detail"] = "; ".join(detail)
        return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--msx", required=True)
    ap.add_argument("--engine", required=True)
    ap.add_argument("--json")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("cases")
    args = ap.parse_args()
    base = os.path.dirname(os.path.abspath(args.cases))
    cases = []
    with open(args.cases) as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if line:
                inp, msx = line.split()
                cases.append((os.path.join(base, inp), os.path.join(base, msx)))
    msx_bin, engine = os.path.abspath(args.msx), os.path.abspath(args.engine)
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        results = list(pool.map(lambda c: run_case(msx_bin, engine, *c), cases))
    for r in results:
        line = f"{r['result']:9s} {r['case']}  (ref {r['ref_seconds']}s, ours {r['ours_seconds']}s)"
        if "detail" in r:
            line += f"\n          {r['detail']}"
        print(line)
    same = sum(r["result"] == "identical" for r in results)
    print(f"{same} of {len(results)} MSX cases identical to EPANET-MSX")
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=1)
    return 0 if same == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
