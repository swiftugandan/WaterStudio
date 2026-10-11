# Working in this repository

WaterStudio is a browser-based, open-source successor to EPA EPANET. Read `docs/PLAN.md` for the design,
`docs/ROADMAP.md` for what is next, and `docs/adr/` for decisions already made.

## Rules

- Trunk-based (ADR 0004): small commits to `main`, each green. Run before committing:
  `cd engine && cargo fmt --check && cargo clippy --release --all-targets -- -D warnings && cargo test --release`,
  and `oracle/parity.sh` after any engine change. For the web workspace: `pnpm lint && pnpm typecheck && pnpm test`
  and `pnpm e2e` (set `PW_CHROMIUM` to a local Chromium if Playwright's download is unavailable).
- Numbers come first. Never loosen a tolerance in `oracle/compare.py`. When a change fixes a network, remove it from
  `oracle/known-failures.txt` in the same commit; say in the commit message which results moved.
- `engine/ws-solver` is a port of OWA-EPANET 2.3.5 (ADR 0006) and must stay bit-identical to it: keep the C
  function names, order of operations and floating-point association. Use `types::pow`/`log` (never `powf`/`ln`).
  `cargo run --release -p ws-solver --example dump` prints every time step for side-by-side debugging.
- `engine/ws-hyd` is a fork of epanet-rs (ADR 0001), kept as a benchmark. Record every change in `engine/ws-hyd/FORK.md`.
- Only `engine/ws-wasm` may use `unsafe`. Elsewhere: no `unwrap`, `expect` or `panic` outside tests.
- Clean room: never read the epanet-js application's source (FSL licence). OWA-EPANET, EPA EPANET, epanet-rs and
  PowerStudio are fine to consult and credit.
- Colours, spacing and type come from `@waterstudio/ui` tokens (`--ws-*`); never hard-code them in components.
  Run `pnpm --filter @waterstudio/ui build` after editing `tokens.ts`.
- Commits end with the `Co-Authored-By` trailer for AI-assisted work.

## Layout

- `engine/`: Rust workspace (`ws-model` canonical model, `ws-io` .inp reader/writer, `ws-solver` hydraulic engine,
  `ws-study` studies, `ws-wasm` WebAssembly boundary, `ws-parity` harness, `ws-cli` command line, `ws-hyd` benchmark)
- `packages/`: `ui` (tokens, icons, components), `symbols` (symbol masters), `engine-client` (engine workers)
- `apps/web`: the app (Vite, React for the shell only)
- `oracle/`: reference engine build, corpus fetch, comparison and ratchet
- `scripts/`: build and verification scripts
- `docs/`: plan, roadmap, ADRs, generated parity report
