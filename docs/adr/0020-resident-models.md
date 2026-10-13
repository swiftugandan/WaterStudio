# ADR 0020: Engines keep the open network and receive only its edits

- Status: accepted
- Date: 2026-10-13

## Context

Until now every analysis sent the whole network: the app converted the document to the canonical model, the
worker received it as JSON, and the engine parsed and built it, for every run and for every chunk of a study.
A fire-flow study over the pool sent the network once per chunk (four per worker). Phase 4's tools run the
engine many times on networks that change a little between runs (sizing, calibration, fire-flow repair, an
agent's edit and analyse loop), so the cost of sending the network grows with each iteration while the change is
one pipe. The plan's worker protocol already called for a snapshot once and op deltas after it.

## Decision

- **Slots, not IDs.** A document addresses each element by its table row, which never changes while the element
  lives, comes back with it on undo and orders the model. A patch replaces slots (`NodeSlot`, `LinkSlot`; `null`
  for a deleted element) and whole sections (patterns, curves, controls, rules, settings) that changed. IDs would
  not do: renaming a node changes the IDs its links name, and a rename is an edit like any other.
- **`ws_model::Mirror`** holds a model with each element's slot. A `Snapshot` (the model and the slots) opens
  it, and a `ModelPatch` from exactly its revision moves it to the next one: a changed element is replaced where
  it is, an added or deleted one is put in or taken out at its slot's position, so the model is never rebuilt
  and the engine runs it in place. Anything else is refused as stale. The types are generated to TypeScript with
  the model, so the two sides cannot drift.
- **The engine holds one mirror per instance.** `ws_session` opens, patches and exports it, and runs a hydraulic
  run, check, study, report files or MSX analysis on it by `(epoch, revision)`. A request for another document or
  revision fails with a message starting `stale session`. The other entry points still take a whole model.
- **`EngineSync` (core) watches a store.** For each revision it records the slots and sections that its
  operations touched, including the links of a renamed node. `patch(from)` reads those slots from the document
  as it is now; `snapshot()` opens an engine. A `load` resets it, and its log is bounded (4,096 revisions), so a
  worker that is too far behind receives a snapshot. Each instance has its own epoch, so two stores never match.
- **`EngineClient` takes a document wherever it took a model.** Before a request it queues, on the chosen
  worker, a patch from the revision that worker holds, or a snapshot. Workers handle messages in order, so the
  request that follows sees the result. A stale reply (an engine that lost its model) clears what the client
  believes that worker holds, and the request is retried once. A worker that recycles its instance to return
  memory (ADR 0018) carries the model to the new one as the engine's own JSON. Since that costs a model's
  transfer, an instance holding a model is recycled above 256 MB rather than 64 MB: a 24-hour run of 10,000
  nodes peaks near 80 MB and stays, one of 100,000 near 800 MB and is recycled.
- **The app uses it** for analyses, report files, MSX, studies and the assistant's draft runs. Scenario
  comparisons and other one-off models are still sent whole.

## Consequences

- After an edit, a 24-hour run of 10,000 nodes sends one pipe instead of the network. Measured in the e2e suite:
  213 ms against 321 ms with the whole network (median of three), gated so the resident run stays the faster.
  The saving is the conversion, the JSON and its parsing, and it grows with the number of runs.
- A study over the pool sends the network once per worker rather than once per chunk, and its chunks carry only
  their hydrants or links.
- The engine still builds its solver project from the model on each run. Keeping the built project and applying
  edits to it is the next step if building ever dominates, and slots make it possible without another protocol.
- Correctness is tested at three levels: `Mirror` in Rust, `EngineSync` against a reference mirror after edits,
  deletes, renames, undo and redo from every earlier revision, and the client against the real engine (sent once,
  patched after, recovered after a lost model, and identical results to the whole model).
