#!/usr/bin/env python3
"""Check that the engine's pow, log, exp and log10 return glibc's bits (ADR 0003).

usage: math-bits.py <mathbits-binary> [samples]

Runs inside the same glibc configuration as the parity reference (compare.py sets
GLIBC_TUNABLES to keep glibc off its FMA variants) and fails on any difference. If
this fails, parity failures are about the math library, not the solver.
"""

import ctypes
import os
import random
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compare import TUNABLES  # noqa: E402


def bits(v):
    return struct.unpack("<Q", struct.pack("<d", v))[0]


def from_bits(u):
    return struct.unpack("<d", struct.pack("<Q", u))[0]


def main():
    if os.environ.get("GLIBC_TUNABLES") != TUNABLES:
        env = dict(os.environ, GLIBC_TUNABLES=TUNABLES)
        os.execve(sys.executable, [sys.executable, "-I", os.path.abspath(__file__)] + sys.argv[1:], env)
    binary = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 200_000
    m = ctypes.CDLL("libm.so.6")
    m.pow.restype, m.pow.argtypes = ctypes.c_double, [ctypes.c_double, ctypes.c_double]
    m.log.restype, m.log.argtypes = ctypes.c_double, [ctypes.c_double]
    m.exp.restype, m.exp.argtypes = ctypes.c_double, [ctypes.c_double]
    m.log10.restype, m.log10.argtypes = ctypes.c_double, [ctypes.c_double]
    rng = random.Random(20261011)
    cases = []
    for _ in range(n):
        r = rng.random()
        if r < 0.3:   # what the hydraulic solver feeds them
            x = rng.uniform(1e-6, 1e4)
            y = rng.choice([0.852, 1.852, 0.5, 1.5, 2.0, 0.54, 0.63, 2.63, 1 / 1.852, rng.uniform(-3, 3)])
        elif r < 0.6:
            x, y = from_bits(rng.getrandbits(63)), rng.uniform(-50, 50)
        elif r < 0.8:
            x, y = rng.uniform(0, 2), rng.uniform(-700, 700)
        else:
            x, y = from_bits(rng.getrandbits(64)), from_bits(rng.getrandbits(64))
        cases.append((x, y))
    text = "".join(f"{bits(x):016x} {bits(y):016x}\n" for x, y in cases)
    out = subprocess.run([binary], input=text, capture_output=True, text=True, check=True).stdout.split("\n")
    bad = {"pow": 0, "log": 0, "exp": 0, "log10": 0}
    for (x, y), line in zip(cases, out):
        got = [int(t, 16) for t in line.split()]
        for name, g, ref in (("pow", got[0], m.pow(x, y)), ("log", got[1], m.log(x)), ("exp", got[2], m.exp(y)),
                             ("log10", got[3], m.log10(x))):
            if g != bits(ref) and not (ref != ref and from_bits(g) != from_bits(g)):
                bad[name] += 1
                if bad[name] <= 3:
                    print(f"{name}({x.hex()}, {y.hex()}): engine {from_bits(g)!r}, glibc {ref!r}")
    print(f"{n} samples, mismatches {bad}")
    return 1 if any(bad.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
