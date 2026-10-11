# ADR 0003: Native and WebAssembly builds must give bit-identical results

- Status: accepted; met on 2026-10-11 (56/56 networks bit-identical to OWA-EPANET in both builds)
- Date: 2026-10-10, revised 2026-10-11

## Context

Run records will carry hashes of results so any run can be reproduced and audited. That requires the same
inputs to give the same bits on every device and in both builds. The spike found native and WebAssembly results
differing in late digits on 32 of 54 networks.

Causes found: the native build called the platform's `libm` while wasm32 used Rust's own; faer dispatched to
AVX2/FMA kernels at run time; and, once `ws-solver` (ADR 0006) reproduced OWA-EPANET's arithmetic exactly, the
only remaining difference from the reference was `pow` and `log`.

glibc itself is not deterministic across machines: on a CPU with FMA it switches `pow`, `exp` and `log` to
variants compiled with fused multiply-add, which round differently in about 0.03 % of calls. So OWA-EPANET's own
results depend on the CPU it runs on.

## Decision

- `ws-solver` uses one implementation of each transcendental function everywhere: `ws_solver::math`, a port of
  ARM optimized-routines' `pow`, `exp` and `log` (MIT OR Apache-2.0), on their path without FMA. These are the
  algorithms glibc uses; the port returns glibc's bits exactly on that path. Square root is IEEE-exact anyway.
- No fused multiply-add anywhere (Rust never contracts `a * b + c`), a fixed order of summation, and no
  runtime-dispatched libraries in the solver.
- The oracle runs OWA-EPANET with `GLIBC_TUNABLES=glibc.cpu.hwcaps=-AVX2,-FMA` (and the older `_Usable` names),
  which keeps glibc on the same portable variants on any CPU. `oracle/math-bits.py` checks in CI that the port and
  glibc agree on 200,000 inputs, so a math-library mismatch is never mistaken for a solver bug.
- The parity gate is bit-identity (ADR 0002 as amended): every head, demand and flow at every report period, in
  both builds, equal to the reference's double-precision value.

## Consequences

- Native and WebAssembly results are identical to each other and to OWA-EPANET, so result hashes are meaningful
  and any discrepancy is a real behaviour change.
- The portable `pow` is a little slower than an FMA one. Measured cost is small next to the sparse solve.
- If glibc ever changes these routines, `math-bits.py` fails first and says so.
