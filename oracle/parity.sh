#!/usr/bin/env bash
# Compares WaterStudio's engine with OWA-EPANET on the whole corpus and our fixtures,
# for the native build and for the WebAssembly build that ships, and enforces the ratchet:
#   * a network not listed in known-failures.txt must match the reference to the bit;
#   * a listed network that now matches is reported, so it can be removed from the list.
# Writes reports to oracle/.reports and a summary to docs/PARITY.md with --write-doc.
#
# Prerequisites: oracle/build.sh, oracle/fetch-corpus.sh, and the engine built:
#   (cd engine && cargo build --release --bins --examples && cargo build --release --target wasm32-unknown-unknown -p ws-wasm)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
reports="$here/.reports"
mkdir -p "$reports"

mapfile -t networks < <(cd "$here/.corpus" && find . -name '*.inp' -not -path '*/msx-examples/*' | sed 's|^\./||' | sort)
# Our own fixtures exercise what the corpus does not: rules, leakage, PDA, every valve type.
mapfile -t fixtures < <(cd "$here/.corpus" && find ../fixtures -name '*.inp' | sort)
if [[ ${#networks[@]} -eq 0 ]]; then
  echo "error: no networks in oracle/.corpus; run oracle/fetch-corpus.sh" >&2
  exit 1
fi

for needed in "$root/engine/target/release/ws-parity" \
              "$root/engine/target/wasm32-unknown-unknown/release/ws_wasm.wasm" \
              "$here/.build/bin/runepanet"; do
  if [[ ! -e "$needed" ]]; then
    echo "error: missing $needed (see the prerequisites at the top of this script)" >&2
    exit 1
  fi
done

status=0
for engine in native wasm; do
  case $engine in
    native) bin="$root/engine/target/release/ws-parity" ;;
    wasm)   bin="$root/scripts/ws-parity-wasm.mjs" ;;
  esac
  echo "== $engine engine vs OWA-EPANET"
  (cd "$here/.corpus" && python3 -I "$here/compare.py" --epanet "$here/.build" --engine "$bin" \
      --json "$reports/$engine.json" "${networks[@]}" "${fixtures[@]}") > "$reports/$engine.txt" || true
  tail -n 1 "$reports/$engine.txt"
  python3 -I "$here/ratchet.py" "$reports/$engine.json" "$here/known-failures.txt" || status=1
done

if [[ "${1:-}" == "--write-doc" ]]; then
  python3 -I "$here/report.py" "$reports/native.json" "$reports/wasm.json" > "$root/docs/PARITY.md"
  echo "Wrote docs/PARITY.md"
fi
exit $status
