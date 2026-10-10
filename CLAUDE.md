# Working in this repository

WaterStudio is a browser-based, open-source successor to EPA EPANET. Read `docs/PLAN.md` for the design,
`docs/ROADMAP.md` for what is next, and `docs/adr/` for decisions already made.

## Rules

- Trunk-based (ADR 0004): small commits to `main`, each green. Run before committing:
  `cd engine && cargo fmt --check && cargo clippy --release --all-targets -- -D warnings && cargo test --release`,
  and `oracle/parity.sh` after any engine change.
- Numbers come first. Never loosen a tolerance in `oracle/compare.py`. When a change fixes a network, remove it from
  `oracle/known-failures.txt` in the same commit; say in the commit message which results moved.
- `engine/ws-hyd` is a fork of epanet-rs (ADR 0001). Record every change to it in `engine/ws-hyd/FORK.md`.
- Only `engine/ws-wasm` may use `unsafe`. Elsewhere: no `unwrap`, `expect` or `panic` outside tests.
- Clean room: never read the epanet-js application's source (FSL licence). OWA-EPANET, EPA EPANET, epanet-rs and
  PowerStudio are fine to consult and credit.
- Commits end with the `Co-Authored-By` trailer for AI-assisted work.

## Layout

- `engine/`: Rust workspace (`ws-hyd` solver, `ws-study` studies, `ws-wasm` WebAssembly boundary, `ws-parity` harness)
- `oracle/`: reference engine build, corpus fetch, comparison and ratchet
- `scripts/`: build and verification scripts
- `docs/`: plan, roadmap, ADRs, generated parity report
