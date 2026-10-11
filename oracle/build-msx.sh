#!/usr/bin/env bash
# Builds the reference multi-species engine, EPA EPANET-MSX, at a pinned commit into oracle/.build/msx,
# linked against the OWA-EPANET built by oracle/build.sh.
# Result: oracle/.build/msx/bin/runepanetmsx and oracle/.build/msx/lib/libepanetmsx.so.
# Like OWA-EPANET, it only checks WaterStudio's results; it is never shipped.
#
# Built without OpenMP so the reference runs serially and gives the same answer every time.
set -euo pipefail

MSX_COMMIT="85a303dca05859389eced63fabd5ea145c096333"   # USEPA/EPANETMSX master, 2025-03-27

here="$(cd "$(dirname "$0")" && pwd)"
epanet="$here/.build"
build="$epanet/msx"
src="$build/src"

if [[ ! -x "$epanet/bin/runepanet" ]]; then
  echo "error: build OWA-EPANET first (oracle/build.sh)" >&2
  exit 1
fi
if [[ -x "$build/bin/runepanetmsx" && -f "$build/VERSION" && "$(cat "$build/VERSION")" == "$MSX_COMMIT" ]]; then
  echo "EPANET-MSX already built in $build"
  exit 0
fi

rm -rf "$build"
mkdir -p "$build/bin" "$build/lib"
git init --quiet "$src"
git -C "$src" fetch --quiet --depth 1 https://github.com/USEPA/EPANETMSX.git "$MSX_COMMIT"
git -C "$src" checkout --quiet FETCH_HEAD

inc=(-I "$src/src/solver" -I "$src/src/solver/include" -I "$epanet/src/include")
# -ffp-contract=off: no fused multiply-add, as in OWA-EPANET's build and our port (ADR 0003).
cflags=(-O2 -fPIC -ffp-contract=off -w)
gcc "${cflags[@]}" "${inc[@]}" -shared -o "$build/lib/libepanetmsx.so" "$src"/src/solver/*.c \
  -L "$epanet/lib" -lepanet2 -lm -Wl,-rpath,"$epanet/lib"
gcc "${cflags[@]}" "${inc[@]}" -o "$build/bin/runepanetmsx" "$src/src/run/msxmain.c" \
  -L "$build/lib" -L "$epanet/lib" -lepanetmsx -lepanet2 -lm \
  -Wl,-rpath,"$build/lib" -Wl,-rpath,"$epanet/lib"
echo "$MSX_COMMIT" > "$build/VERSION"
echo "Built EPANET-MSX ($MSX_COMMIT) in $build"
