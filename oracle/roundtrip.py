#!/usr/bin/env python3
"""Check that WaterStudio's .inp reader and writer lose nothing EPANET uses.

For each network:
  1. `ws canon` reads it and writes it back in canonical form (c1);
  2. `ws canon` on c1 must give c1 again, byte for byte (the writer is a fixed point);
  3. OWA-EPANET solves the original and c1, and every reported value (node demand,
     head, pressure, quality; link flow, velocity, headloss, quality, status, setting,
     reaction rate, friction factor) at every report period must be bit-identical.
     If EPANET refuses the original, it must refuse c1 too.

usage: roundtrip.py --epanet DIR --ws BIN file.inp ...
"""

import argparse
import filecmp
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compare import ENR_LINK, ENR_NODE, ENR_NUM_PERIODS, OutFile, load_lib  # noqa: E402

NODE_ATTRS = {1: "demand", 2: "head", 3: "pressure", 4: "quality"}
LINK_ATTRS = {1: "flow", 2: "velocity", 3: "headloss", 4: "quality", 5: "status",
              6: "setting", 7: "reaction", 8: "friction"}


def run_epanet(epanet, inp, work, tag):
    rpt, out = os.path.join(work, tag + ".rpt"), os.path.join(work, tag + ".out")
    p = subprocess.run([os.path.join(epanet, "bin", "runepanet"), inp, rpt, out],
                       capture_output=True, timeout=300)
    ok = p.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0
    return (out if ok else None), rpt


def results(lib, path):
    f = OutFile(lib, path)
    try:
        size = f.size()
        names = ([f.name(ENR_NODE, i + 1) for i in range(size["nodes"])],
                 [f.name(ENR_LINK, i + 1) for i in range(size["links"])])
        periods = f.time(ENR_NUM_PERIODS)
        data = {}
        for p in range(periods):
            for a in NODE_ATTRS:
                data[("node", a, p)] = f.attribute(ENR_NODE, p, a)
            for a in LINK_ATTRS:
                data[("link", a, p)] = f.attribute(ENR_LINK, p, a)
        return names, periods, data
    finally:
        f.close()


def check(inp, args, lib, work):
    c1, c2 = os.path.join(work, "c1.inp"), os.path.join(work, "c2.inp")
    for src, dst in ((inp, c1), (c1, c2)):
        p = subprocess.run([args.ws, "canon", src, dst], capture_output=True, timeout=300)
        if p.returncode != 0:
            return "canon-failed", p.stderr.decode(errors="replace").strip()[:160]
    if not filecmp.cmp(c1, c2, shallow=False):
        return "not-idempotent", "writing the canonical file again changes it"

    ref, _ = run_epanet(args.epanet, inp, work, "ref")
    out, rpt = run_epanet(args.epanet, c1, work, "canon")
    if ref is None:
        return ("ok-both-refused", "") if out is None else ("now-accepted", "EPANET refuses the original only")
    if out is None:
        with open(rpt, errors="replace") as f:
            errs = [l.strip() for l in f if "Error" in l][:2]
        return "now-refused", " | ".join(errs)[:200]

    n1, p1, d1 = results(lib, ref)
    n2, p2, d2 = results(lib, out)
    if n1 != n2:
        return "ids-differ", "element order or IDs changed"
    if p1 != p2:
        return "periods-differ", f"{p1} vs {p2}"
    for key, vals in d1.items():
        if vals != d2[key]:
            kind, attr, period = key
            names = n1[0] if kind == "node" else n1[1]
            label = (NODE_ATTRS if kind == "node" else LINK_ATTRS)[attr]
            i = next(i for i, (a, b) in enumerate(zip(vals, d2[key])) if a != b)
            return "results-differ", f"{kind} {names[i]} {label} at period {period}: {vals[i]} vs {d2[key][i]}"
    return "ok", ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epanet", required=True)
    ap.add_argument("--ws", required=True)
    ap.add_argument("networks", nargs="+")
    args = ap.parse_args()
    lib = load_lib(args.epanet)
    failures = 0
    for inp in args.networks:
        with tempfile.TemporaryDirectory() as work:
            try:
                status, detail = check(inp, args, lib, work)
            except Exception as e:  # keep going; report the harness problem
                status, detail = "harness-error", str(e)[:160]
        if not status.startswith("ok"):
            failures += 1
        print(f"{status:16} {inp}  {detail}".rstrip())
        sys.stdout.flush()
    print(f"\n{len(args.networks) - failures}/{len(args.networks)} networks round-trip exactly")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
