# ADR 0013: Scenarios override properties over a shared network structure

- Status: accepted
- Date: 2026-10-11

## Context

The plan asks for a base network plus alternatives that inherit, with edits routed to the active one and any two
compared. EPANET has no scenarios (its .scn files are one-way property exports), and an .inp cannot hold extra
sections (EPANET refuses unknown section headers with error 299), so scenarios live with the project.

## Decision

- A scenario (`@waterstudio/core` `Scenarios`) has a name, an optional parent, and overrides: element fields by
  stable handle, and document data (patterns, curves, controls, rules, options, times, report, energy, reactions).
  Effective values resolve from the base through the scenario's ancestors.
- Structure and geometry are shared: adding and deleting elements, IDs, coordinates, vertices and end nodes always
  change the base network for every scenario. This keeps handles, selection and the map identical across
  scenarios and makes comparison element by element. (Facility sets that switch elements in and out are later work.)
- While a scenario is active, store changes to properties are recorded as its overrides, including undo and redo; a
  value set back to the parent's drops the override. The base value of anything overridden is captured the first
  time, and edits to the base keep that copy current.
- Switching rewrites only overridden values through `Store.load`, so it starts a fresh undo history rather than
  mixing steps from different scenarios.
- `modelFor(id)` builds any scenario's model by applying its values to the document directly and reverting them,
  without events or history; the comparison runs two such models on the engine pool.
- Store changes now carry the operations as applied (undo reports the inverse it applied), which scenarios need.

## Consequences

Scenarios persist in the project file (next); exporting a scenario as .inp is switching to it and saving. A
difference map on the canvas is later work; the comparison is a ranked table with summary figures.
