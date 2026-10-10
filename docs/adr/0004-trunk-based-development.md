# ADR 0004: Trunk-based development

- Status: accepted
- Date: 2026-10-10

## Decision

`main` is the only long-lived branch. Changes are small and land within hours, directly by maintainers after
local checks, or through short-lived pull requests. Unfinished work hides behind flags or stays unreachable from
the UI. CI gates every commit on formatting, lints, tests, the WebAssembly build and the parity ratchet.
A commit that breaks `main` is reverted first and fixed second.

## Consequences

No merge debt and no release branches to maintain. Features must be built in slices that are each safe to ship.
