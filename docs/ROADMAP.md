# Roadmap

WaterStudio is built in five phases, each ending at a gate that must pass before the next phase's risky work
starts. The full design is in [PLAN.md](PLAN.md). Items are ticked as they land on `main`.

## Phase 0: Foundations

Gate: `.inp` round-trip lossless on every corpus file; oracle pipeline green. **Engine half met.**

- [x] Licences, contribution rules, governance, security policy
- [x] Engine workspace; epanet-rs forked as `ws-hyd`, builds for wasm32 with SIMD128
- [x] Oracle: OWA-EPANET v2.3.5 pinned build, pinned corpus, comparator, ratchet
- [x] CI: fmt, clippy, tests, wasm build, parity on native and WebAssembly
- [x] Architecture decision records 0001 to 0005
- [x] `ws-model` and `ws-io`: canonical model and lossless `.inp` reader/writer (ADR 0005)
- [x] Round-trip test over the whole corpus and fixtures, gated in CI (60/60 bit-identical)
- [x] `ws` command-line tool: `check`, `canon`
- [ ] JavaScript workspace: pnpm, TypeScript strict, Vite, Vitest, Playwright, lint
- [ ] Design tokens; app icon set; engineering symbol masters (SVG)

## Phase 1: Hydraulic alpha

Gate: hydraulics within tolerance on the whole corpus; a 50,000-pipe network pans within budget on both renderers.

- [ ] Solver reads networks through `ws-io`/`ws-model` only (one parser; fixes zero-diameter tanks and ignored sections)
- [ ] Close the 12 known parity gaps in `oracle/known-failures.txt`
    - [ ] FCV status logic (2fcvs, 5fcvs)
    - [ ] PRV pair flow split (2PRVs-a)
    - [ ] Net3 extended-period drift (controls and tank timing)
    - [ ] Pumped-network flow differences (anytown-3, mod_anytown-3)
    - [ ] Large-network flow differences at tight accuracy (exnet-3, exnet-3H, wolf-3, 57460, NW_Model, NW_Model1)
- [ ] Rule-based controls, with enable/disable (EPANET 2.3)
- [ ] Multiple demand categories per junction
- [ ] Tank volume curves and overflow
- [ ] FAVAD pipe leakage; outflow breakdown (demand, deficit, emitter, leakage)
- [ ] EPANET head-error and flow-change convergence criteria
- [ ] Energy: pump energy, efficiency, cost, demand charge
- [ ] Determinism: native and WebAssembly bit-identical (ADR 0003)
- [ ] Worker pool with document snapshots and edit forwarding
- [ ] Document store with exact undo/redo over columnar tables
- [ ] Renderer: display list, WebGPU and Canvas 2D backends, picking
- [ ] Shell: ribbon, docking panels, inspector, status bar, command palette
- [ ] Draw, edit, run and colour the map

## Phase 2: EPANET parity beta

Gate: every EPANET 2.2 GUI function available; quality within tolerance; WCAG 2.2 AA audit passes.

- [ ] Water quality (`ws-qual`): chemical, age, trace; bulk and wall reactions; four tank mixing models
- [ ] All EPANET reports, graphs and tables; time player
- [ ] MapLibre basemap, CRS, backdrop images
- [ ] GIS and DXF import and export; `.out` and `.rpt` writers
- [ ] Read-only agent tools and the Assistant panel

## Phase 3: Pro 1.0

Gate: MSX examples within tolerance; all performance budgets met; agent evaluation baseline recorded.

- [ ] EPANET-MSX (`ws-msx`)
- [ ] Scenario manager; fire flow, criticality, isolation segments
- [ ] DEM elevations, demand allocation; SQLite project file
- [ ] C toolkit API (`ws-ffi`) and CLI
- [ ] Proposal and review UI; MCP server

## Phase 4: Agent design 1.1

Gate: agent tasks meet the agreed pass rate with no criteria violations in accepted proposals.

- [ ] Layout from streets, least-cost pipe sizing, calibration, fire-flow repair
- [ ] Independent checker role; WebMCP; nightly agent evaluations as a release gate
