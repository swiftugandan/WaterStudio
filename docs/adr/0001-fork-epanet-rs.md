# ADR 0001: Build the engine on a fork of epanet-rs

- Status: accepted
- Date: 2026-10-10

## Context

WaterStudio needs a Rust engine that reproduces EPANET 2.3's results and runs as WebAssembly. Writing the Global
Gradient Algorithm from scratch would take months before the first parity result. epanet-rs (Vitens N.V., MIT OR
Apache-2.0) already re-implements the 2.3 hydraulic solver with faer sparse algebra.

A spike on 2026-10-10 measured it against OWA-EPANET v2.3.5 on 54 networks:

- 40 of 54 matched within strict tolerance out of the box, once tank and reservoir demands were reported in
  EPANET's convention.
- It does not build for `wasm32-unknown-unknown` as published: faer's default features pull in `getrandom` and a
  thread pool.
- Its `.inp` reader only reads files, and ignores sections it does not model (`[SOURCES]`, `[QUALITY]`,
  `[REACTIONS]`, `[ENERGY]`, `[MIXING]`, `[REPORT]`, `[LABELS]` and others).
- Its Darcy-Weisbach friction factor used f32 fast approximations of `pow` and `ln`.
- It lacks rules, multiple demand categories, tank volume curves, leakage, energy and water quality.

## Decision

Fork epanet-rs into `engine/ws-hyd`, imported verbatim in its own commit, with our changes on top as separate
commits listed in `ws-hyd/FORK.md`. Keep the library name `epanet_rs` to keep diffs small. Offer general fixes
upstream.

The lossless `.inp` reader/writer and the canonical model are WaterStudio's own crates (`ws-io`, `ws-model`);
`ws-hyd` becomes the solver behind them.

## Consequences

- With the wasm fix, in-memory parsing and exact maths, 42 of 54 networks match on native and WebAssembly alike.
- We own the solver's correctness from here; the oracle (ADR 0002) is what keeps that honest.
- Upstream changes must be merged by hand; FORK.md records the base commit.
