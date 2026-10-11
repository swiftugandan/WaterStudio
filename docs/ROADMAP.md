# Roadmap

WaterStudio is built in five phases, each ending at a gate that must pass before the next phase's risky work
starts. The full design is in [PLAN.md](PLAN.md). Items are ticked as they land on `main`.

## Phase 0: Foundations

Gate: `.inp` round-trip lossless on every corpus file; oracle pipeline green. **Met.**

- [x] Licences, contribution rules, governance, security policy
- [x] Engine workspace; epanet-rs forked as `ws-hyd`, builds for wasm32 with SIMD128
- [x] Oracle: OWA-EPANET v2.3.5 pinned build, pinned corpus, comparator, ratchet
- [x] CI: fmt, clippy, tests, wasm build, parity on native and WebAssembly
- [x] Architecture decision records 0001 to 0007
- [x] `ws-model` and `ws-io`: canonical model and lossless `.inp` reader/writer (ADR 0005)
- [x] Round-trip test over the whole corpus and fixtures, gated in CI (61/61 bit-identical)
- [x] `ws` command-line tool: `check`, `canon`
- [x] JavaScript workspace: pnpm, TypeScript strict, Vite, Vitest, Playwright with axe-core, ESLint, Prettier (ADR 0007)
- [x] Design tokens with light and dark themes and two densities, contrast-checked in tests
- [x] App logo; hydraulic interface icon set on Lucide's grid; engineering symbol masters (SVG)
- [x] Engine in a worker (`engine-client`) and a preview app exercising it, gated in CI

## Phase 1: Hydraulic alpha

Gate: hydraulics within tolerance on the whole corpus (**met: bit-identical**); a 50,000-pipe network pans within
budget on both renderers.

- [x] `ws-solver`: port of OWA-EPANET 2.3.5's hydraulics (ADR 0006), reading networks through `ws-io`/`ws-model` only
- [x] Close the 12 known parity gaps: all 56 networks bit-identical to OWA-EPANET (was 42/54 within tolerance)
- [x] Rule-based controls, with enable/disable (EPANET 2.3)
- [x] Multiple demand categories per junction
- [x] Tank volume curves and overflow
- [x] FAVAD pipe leakage
- [ ] Outflow breakdown in results (demand, deficit, emitter, leakage)
- [x] EPANET head-error and flow-change convergence criteria
- [x] Energy: pump energy, efficiency, cost, demand charge (computed; reporting in Phase 2)
- [x] Determinism: native and WebAssembly bit-identical (ADR 0003), gated in CI
- [x] Engine workers with typed requests (read, write, run); results as transferred f32 columns
- [ ] Edit forwarding to long-lived engine instances (runs send a snapshot today)
- [x] Document store with exact undo/redo over columnar tables, field catalogue, command bus
- [x] Renderer: display list, WebGPU and Canvas 2D backends in a render worker, picking, device-loss fallback (ADR 0008)
- [x] Shell: ribbon, docking panels, inspector, model browser, results table, status bar, command palette
- [x] Draw, edit, run and colour the map; legends and time player
- [ ] 50,000-pipe pan benchmark on both backends, gated in CI

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
