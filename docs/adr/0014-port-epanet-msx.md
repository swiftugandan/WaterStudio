# ADR 0014: Port EPANET-MSX function by function, checked bit for bit

- Status: accepted
- Date: 2026-10-11

## Context

The plan's definition of complete includes EPANET-MSX 2.0: several interacting species in the bulk flow and on
pipe walls, rate, equilibrium and formula expressions, three integrators and, since 2.0, longitudinal dispersion.
The reference is EPA's C code (USEPA/EPANETMSX, MIT licence), which runs on top of the EPANET toolkit: it reads
the network through the legacy single-precision getters and the hydraulics from EPANET's binary hydraulics file.

ADR 0006 ported OWA-EPANET's hydraulics and quality function by function and got bit-identical results. The same
approach fits MSX: its numerics (adaptive RK5 and ROS2 step control, Newton iterations, segment splitting) amplify
the smallest difference, so a "reimplement to a tolerance" approach would chase drift forever.

## Decision

- `engine/ws-msx` ports EPANET-MSX at commit 85a303dc module by module (`mathexpr.c` to `expr.rs`, `msxinp.c` and
  `msxproj.c` to `input.rs`, `msxchem.c` to `chem.rs`, `rk5.c`, `ros2.c`, `newton.c` and the LU routines to
  `solvers.rs`, `msxqual.c` and `msxtank.c` to `qual.rs`, `msxdispersion.c` and its `smatrix.c` to
  `dispersion.rs`, `msxout.c` and `msxrpt.c` to `output.rs`), keeping C names, 1-based arrays, the order of
  operations, the C macros' handling of negative zero and NaN, and the C code's quirks (prefix keyword matching,
  `Us` resolving to `U`, a leading `-2^2` being `(-2)^2 = 0`, tanks always restarting their integration step).
- Segments live in an arena with indices for the C code's linked-list pointers. The one memory difference: a new
  segment the C code allocates for a link without flow and never frees is recycled; segment identity never affects
  a result.
- The network comes from `ws-solver` as `ToolkitData`: diameters, lengths, roughness and tank volumes rounded to
  `f32` exactly as `ENgetlinkvalue` and `ENgetnodevalue` return them. The hydraulics come as `HydRecord`s, which
  now carry heads, with the hydraulics file's `f32` precision. Because `ws-solver` is bit-identical to OWA-EPANET,
  MSX sees exactly the inputs the C code sees.
- Transcendental functions use the solver's glibc-identical library (ADR 0003); `log10`, used by MSX expressions,
  joins `pow`, `exp` and `log` there and is checked by `oracle/math-bits.py`. Other functions (`sin`, `atan`...)
  use the platform's, so native results match glibc but WebAssembly may differ in the last bit for expressions that
  use them.
- The `COMPILER` option (compile the chemistry into a shared library) is accepted and ignored: expressions are
  always interpreted by the postfix stack evaluator, which is the bytecode VM the plan asked for (no eval).
- `oracle/build-msx.sh` builds the reference against the oracle's OWA-EPANET, without OpenMP, and `oracle/msx.sh`
  requires identical binary results files and MSX reports on every case in `oracle/msx-cases.txt`: the five
  examples shipped with EPANET-MSX and our fixtures for every source type, tank model, hydraulic variable,
  statistic, full coupling and dispersion.

## Consequences

- All cases match the reference to the bit, which passes the Phase 3 gate's "MSX examples within tolerance" with
  no tolerance at all; `ws-msx/tests` pins one results file's hash so drift shows up without the reference.
- `ws msx` writes the MSX report and binary file as `runepanetmsx` does. It does not reproduce the EPANET part of
  `runepanetmsx`'s report, so EPANET's own page breaks (a `PAGESIZE` in the .inp) are not reproduced.
- MSX runs at the C code's speed, within a few tens of percent. Stiff examples are slow in both (Batch-NH2Cl takes
  about two minutes), so the app runs MSX on its own worker, which Stop terminates.
- In the app a species is a result variable named `msx:<id>` beside EPANET's (`ws_msx` adds its columns to the
  run's binary results), so every view of results shows species without code of its own. The app always asks for
  every period, whatever statistic the network reports. The MSX input lives in the project document (one per
  scenario, as other document data) and saves as its own .msx file.
