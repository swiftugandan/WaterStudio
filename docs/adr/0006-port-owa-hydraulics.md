# ADR 0006: Port OWA-EPANET's hydraulic engine to Rust

- Status: accepted; supersedes the solver part of ADR 0001
- Date: 2026-10-10
- Consulted: Claude Fable 5.1, as an independent reviewer

## Context

ADR 0001 forked epanet-rs to get a Rust solver quickly. It reached 42/54 networks within tolerance. What remains:

- 12 networks out of tolerance. Six large ones differ by up to 1 % in a few pipe flows. (An earlier test that set
  ACCURACY to 1e-8 in both engines to compare converged solutions was invalid: EPANET clamps ACCURACY to
  [1e-5, 1e-1], so the reference still stopped at 1e-5.)
- Missing features that make up most of EPANET's hydraulic module: rule-based controls, demand categories, tank
  volume curves, EPANET's convergence criteria, updated PDA convergence, leakage, energy.
- faer dispatches SIMD kernels at run time, which conflicts with bit-identical native and WebAssembly builds (ADR 0003).

## Decision

Write `ws-solver`: a function-by-function port of OWA-EPANET 2.3.5's hydraulic engine (`hydraul.c`, `hydcoeffs.c`,
`hydsolver.c`, `hydstatus.c`, `smatrix.c` with `genmmd.c`, `leakage.c`, `flowbalance.c`, then `rules.c`, then
water quality), in safe Rust, driven from `ws-model`. It keeps EPANET's node ordering and sparse Cholesky, so its
arithmetic follows the reference's.

- Ported functions keep their C names in doc comments. Make them idiomatic only after the parity gate, under
  golden tests.
- Determinism: one implementation of each transcendental function (see ADR 0003); no fused multiply-add; fixed
  summation order; no runtime-dispatched libraries.
- Licensing: OWA-EPANET is MIT. Ported files carry an SPDX header and attribution; `LICENSES/OWA-EPANET.txt` keeps
  its copyright notice.
- `ws-hyd` (the epanet-rs fork) stays as a benchmark and source of ideas, notably parallel extended-period runs.
- API: immutable topology, mutable state, and two levels of change: a parameter edit recomputes
  coefficients; a topology edit redoes ordering and symbolic factorisation.

## Sequencing and gates

1. Adapter from `ws-model` with EPANET's unit conversion; `smatrix` and `genmmd`. Gate: node ordering identical
   to OWA's on every network.
2. Coefficients and the Newton solver. Gate: single-period networks match; native and WebAssembly hashes equal.
3. Status checks, time stepping, simple controls, flow balance. Gate: all corpus networks within tolerance.
4. Leakage; long-lived instance with dirty flags; timing. Gate: full parity; WebAssembly within 3x native OWA.
5. Rules. 6. Water quality.

## Consequences

More code to own, but every remaining parity gap is closed by construction rather than by reverse engineering, and
features arrive in EPANET's own structure.

## Outcome (2026-10-11)

Steps 1 to 5 landed together. On first compile `ws-solver` matched 50 of 54 corpus networks within tolerance; the
remaining differences were an unported synonym (`UNITS SI`) and the math library. With `pow` and `log` ported from
the routines glibc uses (ADR 0003), every network in the corpus and both of our fixtures (rules, leakage, PDA,
every valve and pump type) is bit-identical to OWA-EPANET 2.3.5, natively and in WebAssembly. `ws-study`,
`ws-parity` and `ws-wasm` now run `ws-solver`; `ws-hyd` remains as a benchmark (`ws-parity --reference`).
Water quality (step 6) is Phase 2 work.

## Outcome of step 6 (2026-10-11)

Water quality is a port of `quality.c`, `qualroute.c` and `qualreact.c` inside `ws-solver` (module `quality`)
rather than a separate `ws-qual` crate: it reads and writes the same `Project` state (tank concentrations, link
rate coefficients, source mass) that EPANET's quality solver shares with its hydraulics. As `EN_solveQ` does, it
routes over hydraulic solutions recorded during the hydraulic run at the hydraulics file's f32 precision, and it
keeps EPANET's quirk of reading tank volumes as the hydraulic run left them. Only the fields routing reads are kept
(demands, flows, statuses). Chemical, age and trace analyses, every reaction order, limiting potential, roughness
correlation, all four source types and all four mixing models are bit-identical to OWA-EPANET 2.3.5 on the 14
quality networks in the corpus and fixtures, natively and in WebAssembly.

