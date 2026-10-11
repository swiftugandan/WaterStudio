# ADR 0009: EPANET's report and output file, and the app's results, come from one path

- Status: accepted
- Date: 2026-10-11

## Context

Engineers check models against EPANET's text report (.rpt) and binary output file (.out), and EPANET's GUI shows
what the output file holds. The plan asks for both files and for "every EPANET report, graph and table".

## Decision

- `ws_solver::run_epanet` runs a model as `EN_runproject` does: `EN_solveH` recording each hydraulic solution at
  the hydraulics file's f32 precision, then `EN_solveQ` over the recorded solutions. Values for report periods are
  computed from those f32 solutions exactly as `saveoutput` computes them, including the reaction rate saved before
  the next `ratecoeffs` resets it.
- `output.rs` is a port of `output.c` (prolog, pump energy, periods, time-series statistics, epilog); `report.rs` a
  port of `report.c` (logo, summary, status log, warnings, disconnection checks, flow and mass balances, energy,
  node and link tables, paging) together with `flowbalance.c`. The status log is written from the same places in
  the hydraulic code as in OWA-EPANET, guarded by "a report is being written", so runs without a report pay
  nothing. A small `cfmt` module reproduces the C `printf` conversions the report uses.
- The app's result columns are the output file's variables (plus demand deficit, emitter flow and leakage from the
  toolkit), so the app shows the numbers EPANET's GUI shows. The parity harness keeps comparing double-precision
  toolkit values.
- `oracle/outfile.py` runs `runepanet` and `ws run` on every network and requires identical files: the output file
  byte for byte, the report line for line with the run's clock time masked. It is part of `oracle/parity.sh`.
- The clock time is an input (`RunOptions::date`), so the engine stays deterministic and runs in WebAssembly.

## Consequences

64 of 64 networks produce identical reports and output files, including our fixtures for summaries, full status
logs, energy reports, selected nodes, every report field, limits, paging, time-series statistics and warnings.
Runs that fail (input or ill-conditioning errors) return an error rather than EPANET's partial report. A secondary
report file named by [REPORT] FILE is not written; the primary report then omits the tables, as EPANET's does.
