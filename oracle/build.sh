#!/usr/bin/env bash
# Builds the reference engine, OWA-EPANET, at a pinned release into oracle/.build.
# Result: oracle/.build/bin/runepanet and oracle/.build/lib/libepanet-output.so.
# The reference is used only to check WaterStudio's results; it is never shipped.
set -euo pipefail

OWA_TAG="v2.3.5"
OWA_COMMIT="444725fbf16ab28b0470ef0ed281dc4849d49583"   # the commit $OWA_TAG points at

here="$(cd "$(dirname "$0")" && pwd)"
build="$here/.build"
src="$build/src"

if [[ -x "$build/bin/runepanet" && -f "$build/VERSION" && "$(cat "$build/VERSION")" == "$OWA_COMMIT" ]]; then
  echo "OWA-EPANET $OWA_TAG already built in $build"
  exit 0
fi

rm -rf "$build"
mkdir -p "$build"
git clone --quiet --depth 1 --branch "$OWA_TAG" https://github.com/OpenWaterAnalytics/EPANET.git "$src"
actual="$(git -C "$src" rev-parse HEAD)"
if [[ "$actual" != "$OWA_COMMIT" ]]; then
  echo "error: $OWA_TAG resolved to $actual, expected $OWA_COMMIT" >&2
  exit 1
fi

cmake -S "$src" -B "$src/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$src/build" --parallel >/dev/null
mkdir -p "$build/bin" "$build/lib"
cp "$src/build/bin/runepanet" "$build/bin/"
cp "$src/build/lib/"libepanet*.so* "$build/lib/"
echo "$OWA_COMMIT" > "$build/VERSION"
echo "Built OWA-EPANET $OWA_TAG ($OWA_COMMIT) in $build"
