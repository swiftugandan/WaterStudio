#!/usr/bin/env bash
# Fetches the test networks into oracle/.corpus at pinned commits.
#   owa-examples/  OpenWaterAnalytics/epanet-example-networks (the OWA regression collection)
#   owa-epanet/    Net1-Net3 from OWA-EPANET's own example-networks (MIT)
# The networks are fetched, not copied into this repository, because the regression
# collection carries no licence of its own.
set -euo pipefail

EXAMPLES_COMMIT="4f0ceb2641c35adece59145881f10232c40c26b7"

here="$(cd "$(dirname "$0")" && pwd)"
corpus="$here/.corpus"
mkdir -p "$corpus"

if [[ ! -d "$corpus/owa-examples/.git" ]] || [[ "$(git -C "$corpus/owa-examples" rev-parse HEAD)" != "$EXAMPLES_COMMIT" ]]; then
  rm -rf "$corpus/owa-examples"
  git init --quiet "$corpus/owa-examples"
  git -C "$corpus/owa-examples" fetch --quiet --depth 1 \
    https://github.com/OpenWaterAnalytics/epanet-example-networks.git "$EXAMPLES_COMMIT"
  git -C "$corpus/owa-examples" checkout --quiet FETCH_HEAD
fi

# Net1-Net3 come from the reference engine's own source tree, built by oracle/build.sh.
if [[ -d "$here/.build/src/example-networks" ]]; then
  mkdir -p "$corpus/owa-epanet"
  cp "$here/.build/src/example-networks/"Net*.inp "$corpus/owa-epanet/"
else
  echo "note: run oracle/build.sh first to include Net1-Net3" >&2
fi

echo "Corpus ready in $corpus: $(find "$corpus" -name '*.inp' -not -path '*/msx-examples/*' | wc -l) hydraulic networks"
