# ADR 0015: The project file is a SQLite snapshot of the canonical model

- Status: accepted
- Date: 2026-10-12

## Context

An .inp file holds the network and nothing else. A project also has scenarios (ADR 0013), isolation valves, an
EPANET-MSX input (ADR 0014) and the way it was being viewed, and until now all of that was lost when the tab closed.
The plan asked for one-file projects as SQLite (the official sqlite-wasm build), owned by a storage worker on OPFS,
with entity column chunks, the op log and incremental saving.

Two facts shaped the first version. The canonical model (ADR 0005) is already a lossless, serialisable picture of
the whole network, and element handles are per session, so anything stored must refer to elements by ID. And
writing rows one at a time from JavaScript is slow: 100,000 nodes cost about a second in binding overhead alone.

## Decision

- A project is a SQLite database (`PRAGMA application_id` 0x57535052, "WSPR"; `user_version` 1) written by the new
  `@waterstudio/project` package. The schema is: `meta(key, value)` (format, version, application, saved, file name,
  title), `model(json)` (one row, the canonical model), `scenarios(ord, id, name, parent, json)`, `extras(key, json)`
  (scenario base values, the active scenario, isolation valves, the MSX input) and `settings(key, json)` (map theme,
  open panels).
- Every saved value is JSON, written without loss: NaN, infinities and negative zero become NUL-marked strings, and a
  string that already starts with NUL gets a second one. Reading walks the value only when the text has a NUL escape,
  because a `JSON.parse` reviver costs seven times as much.
- Scenario overrides are stored by element reference (`node:<id>`, `link:<id>`). Opening resolves the references
  against the new session's handles and drops any whose element is gone.
- `nodes` and `links` are SQL views over the model JSON (`json_each`, `json_extract`), so SQL and GIS tools see
  plain tables. They cost nothing to write and are never read back.
- A save is a whole snapshot. The worker builds an in-memory database and exports its bytes
  (`sqlite3_js_db_export`), which download as `.wsproj`. Opening deserialises the bytes (`sqlite3_deserialize`),
  checks the application ID, version and format, and refuses a newer format with a clear message.
- Autosave writes the same snapshot to the origin-private file system a few seconds after the network changes. A
  small record in local storage says when and whether the copy holds unsaved work. The wait grows with the time a
  save takes (ten times as long), so large networks spend under a tenth of the time saving. On start the app says
  when an earlier session left unsaved work, and File › Recover opens it.

## Consequences

- At 100,000 nodes and 200,000 links, a save takes 0.7 s, an open takes 0.75 s, and the file is 60 MB; JSON's
  repeated keys make it several times the size of the same network's .inp. Both run in the worker; on the main thread the cost is `toModel` and
  the copy to the worker.
- The plan's incremental storage (column chunks, the op log, results) is deferred. A v2 schema can add those tables
  and bump `user_version`; v1 files stay readable because the reader accepts every earlier version.
- Results are not stored: a project reopens unsolved, and runs are fast enough to repeat.
- A project names one network file and one MSX input. Exporting any scenario as .inp (and .msx) stays the
  interchange path with EPANET.
- The autosaved copy is per browser profile and holds a single project. When an earlier session left unsaved work,
  editing in a new session replaces that copy; the start-up message says so.
