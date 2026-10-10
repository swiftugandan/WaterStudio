# ws-hyd: WaterStudio's fork of epanet-rs

`ws-hyd` is WaterStudio's hydraulic solver. It starts from
[epanet-rs](https://github.com/vitens/epanet-rs) by Abel Heinsbroek (Vitens N.V.), a Rust re-implementation of the
EPANET 2.3 Global Gradient Algorithm, licensed MIT OR Apache-2.0 (see `LICENSE-MIT` and `LICENSE-APACHE` in this
directory, which are upstream's and are kept as-is).

- **Upstream commit:** `1a387056ce90172e4a1e2790481607e0e65505ef` (version 0.2.3), imported unmodified in the
  commit "engine: import epanet-rs 0.2.3 verbatim as ws-hyd".
- **Library name:** kept as `epanet_rs` in code, so our diffs against upstream stay small and portable.

## Why a fork rather than a dependency

WaterStudio needs changes that a library user cannot make from outside: building for `wasm32-unknown-unknown`,
reading networks from memory, exact floating-point maths for parity with EPANET, and, in later phases, rules,
multiple demand categories, tank volume curves, energy, water quality and a lossless model. We keep the fork close
to upstream and offer every general fix back.

## Changes from upstream

| Change | Why | Offered upstream |
| --- | --- | --- |
| faer without default features | Its defaults pull in `rand`/`getrandom` and a thread pool that do not build for wasm32 | Not yet |
| Removed the `epanet-rs` CLI (`src/main.rs`) and its `clap` dependency | The CLI lives in WaterStudio's own tools | No (local) |
| `Network::from_inp_str` and `read_inp_from(BufRead)` | Parse a network from memory; the WebAssembly build has no filesystem | Not yet |
| Exact `powf`/`ln` in the Darcy-Weisbach friction factor (was f32 `fastapprox`) | Matches EPANET's double-precision maths; brought two Darcy-Weisbach networks within tolerance | Not yet |
