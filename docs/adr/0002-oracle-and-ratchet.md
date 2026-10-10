# ADR 0002: OWA-EPANET as the oracle, with a ratchet

- Status: accepted
- Date: 2026-10-10

## Context

Engineers will trust WaterStudio only if its numbers match EPANET's. A Rust port can drift from the reference in
ways unit tests do not catch: a valve state rule, a convergence criterion, a reporting convention.

## Decision

- Build OWA-EPANET at a pinned release (v2.3.5) in CI, and run it and our engine on a pinned public corpus
  (OWA's epanet-example-networks and Net1 to Net3).
- Compare heads, demands and flows at every report step, matched by element ID, for both the native and the
  WebAssembly builds.
- Tolerances: head 0.001 ft, flow and demand 0.01 % or 0.001 flow units. They never loosen to make a change pass.
- A ratchet: `oracle/known-failures.txt` lists networks that do not match yet, each with what is known. Any other
  network that stops matching fails CI. A listed network that starts matching must be removed from the list.

## Consequences

- Progress is measurable: the known-failures list only shrinks.
- The reference's binary output stores f32, so agreement below about 1e-5 relative is invisible through it. When
  that matters, compare through the toolkit API instead.
- Two correct solvers can stop at different iterates within EPANET's ACCURACY. `compare.py --accuracy 1e-8`
  separates that from real algorithmic differences.
