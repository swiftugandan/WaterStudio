# ADR 0005: One canonical model, and what "lossless .inp" means

- Status: accepted
- Date: 2026-10-10

## Context

Users must be able to open any EPANET file, edit it, and save it without changing what EPANET computes. EPANET's
own writer rounds values to four decimals; epanet-rs's reader drops whole sections and differs from EPANET on
details such as zero-diameter tanks (EPANET makes them reservoirs whose head is elevation + initial level).

## Decision

- `ws-model` holds everything an EPANET 2.3 file can express, in the user's units. Network objects are typed;
  [OPTIONS], [TIMES], [REPORT] and the global lines of [ENERGY] and [REACTIONS] are kept as ordered keyword lines,
  exactly as written. Per-element lines elsewhere are folded into their element, with EPANET's range rules.
- `ws-io` reads `.inp` text following OWA-EPANET 2.3.5's parser line for line (tokeniser, prefix keyword matching,
  defaults, file-order quirks) and reports problems as issues instead of refusing the file.
- **Lossless** means: for every file EPANET accepts, the canonical rewrite (1) is a fixed point of the writer and
  (2) gives bit-identical OWA-EPANET results for every reported variable at every period. Files EPANET refuses
  must stay refused. Element descriptions are kept; free-standing comment lines are not (EPANET discards them).
- `oracle/roundtrip.sh` checks this on the whole corpus and on `oracle/fixtures/`, in CI, with no exceptions list.
- The solver will read networks only through `ws-io` and `ws-model`, so there is one parser.

## Consequences

- 60 of 60 networks round-trip exactly, including the 57,460-node network and the MSX example networks.
- Element order is preserved by writing repeated sections where kinds interleave, as EPANET numbers elements in file
  order.
- Anything the editor adds to the model must have a representation EPANET reads back identically, or a test
  will fail.
