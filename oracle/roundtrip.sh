#!/usr/bin/env bash
# Checks that reading and writing .inp files loses nothing EPANET uses: every corpus
# network and every fixture must give bit-identical OWA-EPANET results after a
# canonical rewrite. There is no known-failures list here; this must always pass.
#
# Prerequisites: oracle/build.sh, oracle/fetch-corpus.sh, and
#   (cd engine && cargo build --release -p ws-cli)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
ws="$root/engine/target/release/ws"
[[ -x "$ws" ]] || { echo "error: missing $ws" >&2; exit 1; }
[[ -x "$here/.build/bin/runepanet" ]] || { echo "error: run oracle/build.sh first" >&2; exit 1; }

mapfile -t networks < <(cd "$here" && { find .corpus -name '*.inp'; find fixtures -name '*.inp'; } | sort)
cd "$here"
python3 -I "$here/roundtrip.py" --epanet "$here/.build" --ws "$ws" "${networks[@]}"
