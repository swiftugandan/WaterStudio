# ADR 0016: The C toolkit API ports epanet.c over the same solver

- Status: accepted
- Date: 2026-10-12

## Context

The plan promises a C toolkit API compatible with EPANET 2.3 so that existing programs (calibration tools,
optimisers, scripts that load `libepanet2` through ctypes, EPANET-MSX-style extensions) can switch engines without
changes. OWA-EPANET's `epanet.c` defines 144 `EN_` functions over its `Project`. Since ADR 0006, `ws-solver`
holds that same `Project`, field by field.

## Decision

- `ws_solver::epanet` ports `epanet.c` function by function. `Toolkit` is an `EN_Project`, and its methods keep the C
  names, arguments, error codes and output conventions: return code plus `&mut` outputs, including the defaults C
  writes before checking its arguments. It is safe Rust inside the solver crate, so other Rust code (and later
  WebAssembly) can use it too.
- `engine/ws-ffi` builds `libepanet2` (`cdylib` and `staticlib`) exporting the same symbols. Its only job is moving
  values across the C boundary. Like `ws-wasm` it may use `unsafe`, confined to that boundary: handles and output
  pointers are checked for null, strings are copied with EPANET's length limits, and nothing from C is kept. OWA's
  `epanet2_2.h` and `epanet2_enums.h` ship unchanged in `ws-ffi/include`.
- Where the toolkit's call sequence reaches state the whole-run path never did, the solver now behaves as C does:
  - Heads, demands, flows, statuses, settings and qualities live from `EN_open` on (`allocdata`), not from
    `EN_openH`, so a second hydraulic run warm-starts like EPANET's.
  - `EN_open` reads without validating. Each `EN_openH` runs `validateproject`, which computes pump curves and
    types them, and returns 223, 224 or 110 as `openhyd` does.
  - The in-memory hydraulics file (`HydRecord`) keeps heads and settings, and `readhyd` restores them.
  - `runhyd` returns `writehydwarn`'s warning code.
  - The end of a hydraulic run completes a concurrent quality run (`Qtime++`).
  - `closequal` frees segments, so links report their end nodes' average quality again.
- Data the solver does not need comes from the model the project was opened from: comments, tags, coordinates,
  vertices, demand category names, titles. Curve types follow EPANET's input order: the type keyword, then tank,
  valve and efficiency uses, then pump head curves once validated.
- `oracle/toolkit.sh` compiles `oracle/toolkit/probe.c` against both libraries and requires identical output on
  the whole corpus and our fixtures. The probe drives:
  - every getter, on every element;
  - stepwise hydraulics, saved and not, warm-started and re-initialised;
  - quality from the saved hydraulics, by `EN_nextQ` and by `EN_stepQ`;
  - quality concurrent with hydraulics;
  - call-order errors and error texts.

  The reference runs with glibc's portable maths (ADR 0003). Doubles print in full, and every array also prints a
  hash of every value's bits and error code.
- Computed values (heads, flows...) are compared only after a solver has run. Before that, EPANET's arrays hold what
  parsing left in them: raw `[JUNCTIONS]` demands, or a MISSING marker where `[DEMANDS]` replaced them. No model
  keeps that state, and no program should read it.
- Known differences are listed per network and property in `oracle/toolkit-known.txt`. The harness ignores only
  those and reports when one disappears. The only entry so far: a `[TANKS]` line with zero diameter, which EPANET
  runs as a reservoir (as we do, with identical results). EPANET's getters still report that line's levels, volume
  curve and volume, which the canonical model, keeping it as a reservoir, does not hold.

## Consequences

- **Stage 1.** Project, analysis and reporting-statistic functions, plus every getter: nodes, links, demands,
  patterns, curves, simple controls, options, times, quality settings, comments, tags, coordinates, vertices.
  `EN_runproject` writes EPANET's report and output file as `ws run` does.
- **Stage 2.** Every setter of those, plus adding and deleting demands, patterns, curves and simple controls:
  element properties (including tank geometry and volume curves), junction, tank and pipe data, IDs, titles,
  comments, tags, coordinates, vertices, demand categories, pump curves, valve types, options (including emitter
  exponent, specific gravity and pressure units, which rescale stored values), flow units (which convert curves
  and rules), time parameters, demand model and quality type.
- Setters reach solver state the whole-run path never touches. It now follows C there too:
  - Node qualities persist between quality runs (`NodeQual` is allocated at open).
  - With quality open concurrently, the hydraulic step leaves the report time to the quality solver.
  - The toolkit's `Meta` (comments, tags, coordinates, vertices, demand names, titles) lives in solver order beside
    the `Project`, as C keeps it in `Snode` and `Slink`.
- **Stage 3.** Network structure: `EN_addnode`, `EN_deletenode`, `EN_addlink`, `EN_deletelink`, `EN_setlinknodes`
  and `EN_setlinktype`. These move every index into the network as C does: tanks, link ends, pumps, valves,
  controls and rule premises, including C's quirk that a premise on the first tank keeps its index when a junction
  is added. Each element's `ResultIndex` moves with it. As in C, hydraulic results stay where they were until the
  next `EN_initH`. The adjacency lists are rebuilt whenever a solver opens.
- **Stage 4.** Rule-based controls: `EN_addrule` parses rule text with the same parser as `[RULES]`, and the
  rest read and change rules, premises, actions, priorities and whether a rule is enabled. As in C, a failed
  `EN_addrule` deletes the last rule. `EN_setpremise` accepts only codes the evaluator knows (251 otherwise), where
  C stores any number. Every failing `EN_addrule` crashes OWA-EPANET 2.3.5, so the probe compares valid rules only.
- The probe's mutation scenario applies every kind of setter to each network, valid calls and invalid ones (return
  codes printed), then reads everything and solves again: 64 of 64 networks give identical output.
- The probe avoids what is undefined in OWA-EPANET:
  - `EN_SOURCEMASS` on a source `EN_setnodevalue` has just made reads uninitialised memory.
  - `EN_gettitle` leaves a 79-character title unterminated, so the probe zeroes its buffers.
  - After structural edits, nodes' full demands and qualities are stale or uninitialised until a run sets them.
  - Results are read only after a successful solve.
- **Stage 5.** Reports and output files. `EN_open` opens the report and output files it is given (or reports to
  standard output when the report name is empty), and the rest of the reporting API follows: `EN_writeline`,
  `EN_setreport`, `EN_resetreport`, `EN_setstatusreport`, `EN_report`, `EN_copyreport`, `EN_clearreport` and the
  report callback. The status log is written as each solver runs, `EN_saveH` writes the output file (applying
  the time statistic as `savetimestat` does), and error messages land in the report as `errmsg` puts them there.
  The whole-run path and the toolkit share one writer for the output file.
- Following the toolkit there brought two more whole-run behaviours in line with C:
  - An ill-conditioned network now writes `writehyderr`'s lines (the node, tank statuses and disconnected
    junctions) before error 110.
  - Changing flow or pressure units through the toolkit updates the report's field units.
- `toolkit.sh` compares the probe's report, its copy and its output file byte for byte, report dates aside, and
  the output file's ID fields without their 32nd byte: OWA-EPANET copies a new element's ID with `strncpy(ID, id,
  MAXID)`, leaving that byte as whatever `realloc` returned, and writes it out (`oracle/toolkit/outnorm.py`).
- Two more places where the probe avoids undefined behaviour in OWA-EPANET:
  - `EN_NEXTEVENT` and `EN_NEXTEVENTTANK` read uninitialised tank state before any solve.
  - After a failed `EN_solveH`, `EN_saveH` and `EN_solveQ` corrupt the heap (the reference aborts in `closequal`).
- **Stage 6.** `EN_saveinpfile` ports `inpfile.c` and `writerule`: the project as the toolkit holds it now,
  in EPANET's layout and number formats, with `[LABELS]` and `[BACKDROP]` copied from the input file read again
  from disk, as C does. The probe saves each network before and after its changes, `toolkit.sh` requires both
  files identical to OWA-EPANET's, and each library then reads back the changed network it saved and solves it
  again, with identical results on all 64 networks. Field padding now counts bytes, as `printf` does.
- **Stage 7.** External hydraulics files. `EN_savehydfile` writes the last saved hydraulic run in EPANET's
  binary layout (header, f32 records, steps, and the `EOFMARK` byte after the last step), or copies the file in
  use. `EN_usehydfile` reads one back after checking it was saved for this network (306 otherwise); quality runs
  then read their hydraulics from it, the hydraulic solver refuses to open (107), and trying to open it forgets
  the file's results, as in C. The probe saves the first run's file, has a fresh project use it for quality,
  report and output, and compares every file. The `[OPTIONS]` keyword `HYDRAULICS USE/SAVE` in an input file is
  still ignored when reading; `EN_saveinpfile` writes it for a file in use.
- **Stage 8.** `EN_init` makes an empty project with the given flow units and head loss formula; as in C its
  report keeps quality as a reported variable (`initreport` runs after `adjustdata`). The probe builds a network
  from nothing with the editing functions, solves it and saves it, identically to OWA-EPANET. `EN_addrule`
  crashes the reference in such a project, so the probe leaves rules out there. `EN_open` without a readable
  input file now writes no report, as `openfiles` opens the input first.
- **Stage 9.** The legacy single-precision API of `epanet2.h`: 141 `EN...` functions on one project the library
  keeps, forwarding as `epanet2.c` does, with real values as `float`. Most are generated from `epanet2.c`
  (`scripts/gen-legacy-api.py`); the dozen that do more (whole runs, arrays, `ENgetcurve`) are written out.
  `oracle/toolkit/legacy.c` drives them on every network (values, setters, patterns, curves, controls, rules,
  hydraulics, quality, saved input, report and output files, `ENepanet`) and `toolkit.sh` requires identical
  output and files. On the way, `openhyd` now leaves link statuses zeroed as `calloc` does, and a curve of fewer
  than two points no longer panics (both only reachable by running the solver without `EN_initH`, which reads
  uninitialised memory in the reference).
- **Stage 10.** Input errors as EPANET reports them, and `EN_openX`/`ENopenX`. `ws_io::check_inp` ports
  `netsize`, `readdata`, every section parser of `input3.c` and `ruledata`'s checks: the same codes, blamed tokens
  and order, with C's quirks (a time token cut at its colon by `hour`'s `strtok`, the coefficient blamed for a
  negative leakage expansion, the last link read escaping `valvecheck`, every rule after a bad one ignored, lines
  over 1,023 characters read as several). `EN_open` writes each error as `inperrmsg` and `ruleerrmsg` do, with the
  page size and title read before it, after a logo written before any data. `EN_openX` opens the network EPANET
  keeps: `Check::repaired` is the file with each bad line cut to what C's parser had already taken from it (a
  junction or pipe keeps the values before the bad one, a tank with a bad level becomes the reservoir C makes of
  it, a pattern keeps C's padding of 1.0), so the ordinary reader builds it. `read_inp` reports exactly these
  errors, with their codes, so the editor shows what EPANET would. `validateproject` now checks every tank, pump,
  pattern and curve and reports each as C does, and `EN_runproject` (and `ws run`) runs the toolkit's own
  sequence, so a file or network that will not run leaves C's report. `oracle/input-errors/` holds files that
  reach every error and partial line; `toolkit.sh` requires both libraries' reports, partly read networks, saved
  files and solutions to be identical.

  Two things differ on purpose. A [PIPES] line before [OPTIONS] UNITS is no longer read with US defaults: the
  reader follows the unit system read so far, as C does (a valid-file fix; `oracle/fixtures/options-first.inp`).
  And where C keeps an undefined pattern on a junction or reservoir line as index -1, which crashes its solver,
  the partly read network has no pattern there.
