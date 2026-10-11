#!/usr/bin/env bash
# Compares WaterStudio's multi-species engine with EPA EPANET-MSX on the cases in
# msx-cases.txt: binary results files and MSX reports must be identical (oracle/msx.py).
#
# Prerequisites: oracle/build.sh, oracle/build-msx.sh, oracle/fetch-corpus.sh, and
#   (cd engine && cargo build --release --bins)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
reports="$here/.reports"
mkdir -p "$reports"
for needed in "$root/engine/target/release/ws" "$here/.build/msx/bin/runepanetmsx"; do
  if [[ ! -e "$needed" ]]; then
    echo "error: missing $needed (see the prerequisites at the top of this script)" >&2
    exit 1
  fi
done
echo "== multi-species engine vs EPANET-MSX"
python3 -I "$here/msx.py" --msx "$here/.build/msx/bin/runepanetmsx" --engine "$root/engine/target/release/ws" \
  --json "$reports/msx.json" "$here/msx-cases.txt" | tee "$reports/msx.txt"
