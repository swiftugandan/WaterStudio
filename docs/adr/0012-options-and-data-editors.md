# ADR 0012: Options are edited through a catalogue that matches lines as the engine does

- Status: accepted
- Date: 2026-10-11

## Context

EPANET keeps project options as keyword lines in [OPTIONS], [TIMES], [REACTIONS], [ENERGY] and [REPORT]. The model
keeps those sections verbatim (ADR 0005) so files round-trip, and the engine reads them with EPANET's prefix
matching (`HEADL`, `UNBA`, `PATT` …) and its order rules (`PRESSURE EXPONENT` is not the pressure units; the last
line wins; NODES lines accumulate). An editor that parsed the sections its own way could show one value while the
engine used another.

## Decision

- `@waterstudio/core` has an option catalogue (`options.ts`): for each option, its section, label, help, the
  canonical keywords to write, a matcher that mirrors the engine's code for that keyword, how to read the value,
  its kind (choice, number with bounds, duration, clock time, pattern) and EPANET's default.
- Reading takes the line the engine would use. Writing replaces every line that sets the option with one canonical
  line at the place of the first, keeping its comment; clearing removes them, which restores EPANET's default.
  Lines the catalogue does not cover are never touched. Times are parsed with a port of EPANET's `hour`.
- Patterns and curves are edited through `data.ts`: renaming one renames every reference (element fields, demand
  categories, sources and the options that name patterns) in one undoable step; one in use cannot be deleted.
  A curve's kind is the 2.3 keyword when present, else implied by its first use.
- Controls and rules are edited as text in EPANET's syntax. Apply runs the edited model through the engine's input
  stage (`ws_solver::check`, exposed as `ws_check`), so anything EPANET would refuse is reported with EPANET's
  message and never reaches the model.

## Consequences

The options editor, agent tools and any later importer share one definition of what each line means. Changing flow
units relabels values without converting them, as in EPANET; a converting command is later work.
