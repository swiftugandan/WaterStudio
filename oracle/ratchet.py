#!/usr/bin/env python3
"""Fail if a network outside the known-failures list does not match the reference to the bit.

usage: ratchet.py <compare-report.json> <known-failures.txt>
known-failures.txt lists one corpus-relative path per line; '#' starts a comment.
"""

import json
import sys


def main():
    report_path, known_path = sys.argv[1], sys.argv[2]
    with open(report_path) as f:
        rows = json.load(f)
    known = set()
    with open(known_path) as f:
        for line in f:
            entry = line.split("#", 1)[0].strip()
            if entry:
                known.add(entry)

    def passes(r):
        return r["status"] == "ok" and r.get("exact", False)

    regressions = [r for r in rows if not passes(r) and r["network"] not in known]
    fixed = sorted(r["network"] for r in rows if passes(r) and r["network"] in known)
    stale = sorted(known - {r["network"] for r in rows})

    for r in regressions:
        why = r.get("detail", "")
        if r["status"] == "ok":
            why = f"within tolerance but {r.get('inexact_values')} of {r.get('values')} values differ in the last bits"
        print(f"REGRESSION  {r['network']}: {r['status']} {why}".rstrip())
    for n in fixed:
        print(f"now passes  {n}: remove it from known-failures.txt")
    for n in stale:
        print(f"not in corpus  {n}: remove it from known-failures.txt")
    return 1 if regressions or stale else 0


if __name__ == "__main__":
    sys.exit(main())
