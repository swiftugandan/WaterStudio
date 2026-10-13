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
budget on both renderers (**met for Canvas 2D in CI; WebGPU measured on real GPUs**).

- [x] `ws-solver`: port of OWA-EPANET 2.3.5's hydraulics (ADR 0006), reading networks through `ws-io`/`ws-model` only
- [x] Close the 12 known parity gaps: all 56 networks bit-identical to OWA-EPANET (was 42/54 within tolerance)
- [x] Rule-based controls, with enable/disable (EPANET 2.3)
- [x] Multiple demand categories per junction
- [x] Tank volume curves and overflow
- [x] FAVAD pipe leakage
- [x] Outflow breakdown in results: each node's outflow (EPANET's demand) and, at a junction, the consumer demand
  delivered, emitter flow and leakage that make it up, with the demand not delivered under PDA; result columns
  for the map, tables and graphs, and the breakdown under the demand in the inspector
- [x] EPANET head-error and flow-change convergence criteria
- [x] Energy: pump energy, efficiency, cost, demand charge (computed; reporting in Phase 2)
- [x] Determinism: native and WebAssembly bit-identical (ADR 0003), gated in CI
- [x] Engine workers with typed requests (read, write, run); results as transferred f32 columns
- [x] Edit forwarding to long-lived engine instances (ADR 0020): engines keep the open network and receive only
  the slots and sections an edit changed; analyses, studies, report files, MSX and the assistant's drafts use it
- [x] Document store with exact undo/redo over columnar tables, field catalogue, command bus
- [x] Renderer: display list, WebGPU and Canvas 2D backends in a render worker, picking, device-loss fallback (ADR 0008)
- [x] Shell: ribbon, docking panels, inspector, model browser, results table, status bar, command palette
- [x] Draw, edit, run and colour the map; legends and time player
- [x] 50,000-pipe pan benchmark, gated in CI: Canvas 2D ~55 fps on a CPU rasteriser (budget 30)

## Phase 2: EPANET parity beta (gate passed 2026-10-11)

Gate: every EPANET 2.2 GUI function available; quality within tolerance; WCAG 2.2 AA audit passes.
Quality is bit-identical on every quality network; the audit is `docs/ACCESSIBILITY.md` (one exception: dock
splitters need dragging; panels can be closed, reopened and tabbed instead). EPANET's graph-options dialog
(titles, axis ranges, series colours) is the one GUI function left for Phase 3.

- [x] Water quality (in `ws-solver`, ADR 0006): chemical, age, trace; bulk and wall reactions of any order; sources;
  four tank mixing models. Bit-identical with OWA-EPANET's `EN_solveQ` on 14 quality networks, native and wasm
- [x] Graphs: time series, profile, frequency, system flow, each with a data table; time player
- [x] Reports: status log, energy, reaction rates, full report; .rpt and .out downloads
- [x] Editors (ADR 0012): options and title; patterns and curves with charts; simple controls and rules checked by the
  engine; demand categories, quality sources and tank mixing in the inspector. Each change is one undo step
- [x] Contour plot (Delaunay bands in the map's legend classes) and calibration report (EPANET .dat measurements,
  per-location and network statistics, correlation of means, computed against observed plot)
- [x] MapLibre basemap, CRS, backdrop images (ADR 0010)
- [x] `.out` and `.rpt` writers (ADR 0009): identical to `runepanet`'s on all 64 networks; app results follow the `.out`
- [x] GeoJSON and DXF import and export (`@waterstudio/gis`); GeoJSON in longitude and latitude is projected to its UTM zone
- [x] Shapefile import and export: point and line layers with dBASE attributes, from a .zip or loose files; the .prj's
  coordinate system is used when it names one; exports are WGS 84 with a .prj when the model has a CRS
- [x] Read-only agent tools and the Assistant panel (`@waterstudio/agents`, ADR 0011): Anthropic and
  OpenAI-compatible providers, every tool call shown
- [x] Map and editing: find, query, group edit; sortable, filterable results table; copy and paste properties;
  vertex editing, reverse, auto-length; map labels, ID and value labels, flow arrows, sizes, overview map; legend
  editor; number formats; defaults and project summary; backdrop alignment
- [x] Files: EPANET scenarios; map export as SVG and PNG, printing; tables and graphs copied to the clipboard
- [x] WCAG 2.2 AA audit (`docs/ACCESSIBILITY.md`): keyboard paths for selecting, adding, moving and panning;
  axe checks on every panel in both themes in CI; single-key shortcuts can be turned off

## Phase 3: Pro 1.0

Gate: MSX examples within tolerance; all performance budgets met; agent evaluation baseline recorded.

- [x] Graph options: title, axis limits, grid lines (the last EPANET GUI function)

- [x] EPANET-MSX engine (`ws-msx`, ADR 0014): a port of EPANET-MSX 2.0 that matches the reference to the bit on its
  five examples and our fixtures (every source type, tank model, statistic, equilibrium coupling, dispersion);
  `ws msx` on the command line
- [x] EPANET-MSX in the app: the Multi-species panel edits the MSX input (errors point at their line), runs the
  hydraulics and MSX on a separate worker that can be stopped, and every species becomes a result variable on the
  map, in graphs, the results table, the inspector, queries and legends; the MSX report and input save as files
- [x] Scenario manager (ADR 0013): property overrides that inherit as a tree over a shared network; compare any two
- [x] Fire flow (available flow at a residual and system pressure, warm-started regula falsi), criticality (each link out
  of service over the whole simulation), isolation segments (valves at pipe ends, N−1 and every-end rules, unintended
  isolation); studies split across the engine pool
- [x] Elevations from a DEM (GeoTIFF or ASCII grid, reprojected when it names another CRS) or online terrain tiles;
  demand allocation (a total spread equally or by the pipe length each junction serves, or customer demands at
  points assigned to the nearest junction or split along the nearest pipe) into any demand category
- [x] SQLite project file (ADR 0015): .wsproj holds the network, scenarios, isolation valves, the MSX input and view
  settings, with `nodes` and `links` views for SQL tools; autosaved to the browser's private file system and
  recoverable after a crash or a closed tab
- [x] C toolkit API (`ws-ffi`, ADR 0016) and CLI: a drop-in `libepanet2` identical to OWA-EPANET's on every network:
  project, analysis, every getter and setter, network structure, rules, reports, output, input and hydraulics
  files, `EN_init`, the legacy `epanet2.h` API, and input errors as EPANET reports them with `EN_openX` opening
  the network it partly read (identical on 84 networks, 19 of them files with input errors)
- [x] Proposals (ADR 0017): with the assistant allowed to propose (the default), it edits a draft copy of the
  network, runs it, and submits a changeset with the engine's before-and-after figures; the Proposals panel shows
  the rationale, the evidence and every change, and the engineer accepts all or some of it as one undoable step,
  rejects it or sends it back with a comment; items whose element changed meanwhile are skipped as conflicts
- [x] MCP server (`apps/mcp-server`, ADR 0017): `ws-mcp network.inp` serves the same tools, drafts and proposals
  to MCP clients on stdio (stateless 2026-07-28 revision, `initialize` for earlier clients); proposals land in a
  file the Proposals panel opens, and only `--accept` lets the agent apply them and save
- [x] Performance budgets (ADR 0018), gated in the e2e suite on Canvas 2D: open 10,000 pipes in 0.2 s; 200,000
  links pan at 54 fps; a time step of 100,000 elements in 4 ms; 24-hour EPS of 10,000 nodes in 0.3 s; fire flow at
  1,000 hydrants in 16 s on one worker (about 2 s on 8); edit to repaint in 20 ms; 449 MB for 100,000 elements
  with a run. The sparse solver assembles in place (still bit-identical); fire flow reuses a warm solver and
  regula falsi; the overview is rasterised and recolours only changed links; edits patch the scene; the
  engine worker returns WebAssembly memory after large runs
- [x] Agent evaluation (ADR 0019, `apps/agent-eval`, `docs/evals`): 14 tasks on Net1–Net3 (lookups, results,
  diagnosis, design, edits, conduct) through the real assistant loop, graded against the engine. Baseline:
  reference 14/14, null 0/14, wrong work rejected; the nightly workflow adds a model row when the repository has
  an API key secret (none yet)

## Phase 4: Agent design 1.1

Gate: agent tasks meet the agreed pass rate with no criteria violations in accepted proposals.

- [ ] Layout from streets, least-cost pipe sizing, calibration, fire-flow repair
- [x] Design criteria profile (Options, saved in the project) checked by people, agents and the checker alike
  (ADR 0021)
- [x] Independent checker role: every proposal applied to the current network, solved before and after and judged
  against the criteria, blind to its author's rationale; an optional second-assistant review (ADR 0021)
- [x] Nightly agent evaluations as a release gate: `docs/evals/gate.json`, applied nightly and by `release.yml` on
  version tags (a model run is required, so releases wait for the `WS_EVAL_API_KEY` secret)
- [ ] WebMCP
