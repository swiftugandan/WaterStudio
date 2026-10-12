# ADR 0018: How the performance budgets are measured and met

- Status: accepted
- Date: 2026-10-12

## Context

PLAN.md sets seven budgets and says a miss fails the build. CI has no GPU, and gives the browser
whatever cores the runner has, while the budgets name 8 workers and a mid-range laptop. A synthetic
test network decides what a budget means: a dense grid has twice the pipes per junction of a real
system, which doubles the linear algebra and makes fire flow converge slowly.

## Decision

- **One spec, in the e2e suite.** `apps/web/e2e/perf.spec.ts` runs against the production build in
  the normal `pnpm e2e` run. It prints every figure as `[perf]` and attaches it to the report, and it
  fails when a budget is missed.
- **Canvas 2D is the measured backend in CI.** Drawing budgets are checked on the backend the
  browser gives there. WebGPU is measured on real GPUs, the same as at the Phase 1 gate. Panning
  counts frames the render worker reports (`frameStats`). A time step counts the paint on the main
  thread plus the worker's draw. An edit is timed from the transaction until the worker finishes
  drawing the frame with the change, using the absolute timestamp the worker reports
  (`performance.timeOrigin + now`). A long-task observer runs alongside.
- **Realistic networks.** `bench.networkModel(n)` builds a street network with about 1.25 pipes per
  junction (a comb with cross streets every few blocks, a 24-inch trunk and 12-inch mains), close to
  NW_Model's 1.16. EPS and fire flow are measured on it. The full grid (`epsModel`) is also reported,
  as a harder case.
- **Fire flow scales to the pool.** The budget is 10 s on 8 workers. The test runs on the pool the
  browser gets, and scales the budget by 8/workers. Hydrants are split into independent chunks, so the
  time goes down roughly in proportion to the worker count.
- **Memory** is the resident size of the tab's renderer process (Chrome DevTools Protocol
  `SystemInfo.getProcessInfo`, then `/proc`) after opening the network and running 24 hours. It is read
  after a garbage collection in the page and every worker (Chromium started with `--expose-gc`), as
  `performance.measureUserAgentSpecificMemory`, the method PLAN.md names, reports. The figure before
  collection is printed too. Resident size counts the WebAssembly memory and canvases that a JavaScript
  heap figure leaves out.

What it took to meet the budgets:

- **Sparse solver (still bit-identical).** `factorize` marks adjacency with a stamp array instead of
  searching a list. `createsparse` maps each link's matrix entry straight to its factor position, so
  `linsolve` assembles in place with no copy. The order of operations is unchanged; parity, MSX and
  the toolkit harnesses stay identical.
- **Fire flow.** One solver is reused across hydrants, starting from the base solution. The search
  probes the design flow first, then the largest flow, then uses Illinois regula falsi on x = q^1.852,
  where pressure is nearly linear in x. This takes about 4 solves per hydrant instead of about 15
  bisection steps.
- **Overview rasteriser.** When pipes are a few pixels long, the Canvas 2D backend writes their pixels
  straight into an image, keeping a per-pixel link id. Recolouring for a new time step then repaints
  pixels without re-stroking.
- **Incremental scene patches.** Moving nodes or vertices patches the scene's coordinate buffers and
  the spatial grid in place, and redraws only the dirty rectangle. A large change, a new vertex, or
  moving outside the bounds rebuilds the scene. The map flushes edits in a microtask, not at the next
  animation frame.
- **Recolouring only what changed.** The overview keeps each link's pixels, grouped by a counting sort of
  the id buffer, and the colour each link shows. A time step repaints only the links whose colour class
  changed, and puts back only the rectangle they span. A pixel test checks the result equals a full
  redraw.
- **Engine memory is returned.** WebAssembly memory grows to a run's peak and never shrinks. After a
  request that left the instance over 64 MiB, the engine worker drops it and instantiates a fresh one
  from the compiled module for the next request. For 100,000 elements this frees about 270 MB that
  otherwise stayed live (after collection, 718 MB without it, 449 MB with it).

## Consequences

- The budgets are regression tests: every commit that runs e2e runs them.
- Figures on the CI runner are a lower bound for a laptop with a GPU, and fire flow is checked on fewer
  workers than the budget allows.
- Worst-case budgets (a time step's slowest of six) are exposed to scheduling stalls on small machines.
  On a two-core box, about one run in ten stalls past 16 ms while the typical step takes 3–4 ms. CI
  runners have four cores.
- The WebGPU backend receives patches as a full re-upload of the scene buffers. That is within budget
  because its uploads are cheap, but it has room to improve.
