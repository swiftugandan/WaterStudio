# ADR 0008: One scene, two backends, drawn in a worker

- Status: accepted
- Date: 2026-10-11

## Context

The plan (PLAN.md, "CAD canvas and rendering") calls for WebGPU where available and a first-class Canvas 2D
fallback, drawing one backend-neutral display list, with picking on the CPU.

## Decision

- `buildScene(doc)` turns the document into flat typed arrays: node points, link segments, link symbols (pumps,
  valves, check valves at the link's midpoint with its bearing). Coordinates are f32 relative to an f64 origin at
  the network's centre, so street zoom stays precise without f64 on the GPU. Element order is the document's live
  order, which is also the engine's result order, so result columns map onto the scene by position after a
  handle lookup.
- Colour is a per-element class (0 = theme colour, k = legend class) plus per-element flags (selected, hovered,
  hidden). Stepping through time or changing the selection rewrites one small buffer.
- **WebGPU**: instanced SDF capsules for segments, SDF circles for junctions, sprites from a symbol atlas rasterised
  from the SVG masters. Selection and hover are extra passes over the same buffers.
- **Canvas 2D**: one Path2D per colour class, rasterised into a cache bitmap covering the view plus half a view on
  every side. Panning blits the cache; it is redrawn when the view leaves it, the zoom changes, or the network,
  colours or hidden elements change. Zoomed in, only items near the view (found through a uniform grid) go into
  the paths. Selection, hover and symbols are drawn live on top. Panning a 50,245-pipe grid runs at about 55 fps
  on SwiftShader's CPU rasteriser, within a few frames of an empty canvas; without the cache it was 21 fps.
- Both run in a render worker on an OffscreenCanvas (main thread if the canvas cannot be transferred). The camera,
  picking (flatbush R-trees) and overlays (rubber band, move and draw previews) stay on the main thread.
- If the GPU device is lost, the renderer replaces its canvas, restarts on Canvas 2D and says why in the status bar.

## Consequences

- Headless Chromium with SwiftShader (our CI) loses a WebGPU device as soon as it presents to a canvas, so browser
  tests exercise the Canvas 2D path and the fallback itself; WebGPU shaders are still compiled and validated there
  before the loss, and renderer errors fail the e2e tests. Real browsers keep WebGPU.
- Moving elements hides them in the scene and draws them on the overlay until the drop, so a drag never rebuilds
  the scene.
