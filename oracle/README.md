# The oracle

WaterStudio's numbers are checked against **OWA-EPANET**, the community reference engine, built from a pinned
release. The reference only checks our results; it is never part of what we ship.

| File | Purpose |
| --- | --- |
| `build.sh` | Builds OWA-EPANET v2.3.5 (pinned to its commit) into `.build/` |
| `fetch-corpus.sh` | Fetches the test networks into `.corpus/` at pinned commits |
| `compare.py` | Runs both engines on each network and compares heads, demands and flows at every report step |
| `parity.sh` | Runs `compare.py` for the native and WebAssembly engines and enforces the ratchet |
| `ratchet.py` | Fails on any network outside `known-failures.txt` that stops matching |
| `known-failures.txt` | Networks that do not match yet, each with what is known |
| `report.py` | Writes `docs/PARITY.md` |
| `roundtrip.py`, `roundtrip.sh` | Rewrites every network canonically and requires bit-identical OWA-EPANET results (ADR 0005) |
| `fixtures/` | Our own networks covering features the corpus does not (licensed with the repository) |

`compare.py --accuracy 1e-8` rewrites ACCURACY in both engines before solving. Use it to tell apart differences
caused by where each solver stops iterating from differences in the algorithm itself.
