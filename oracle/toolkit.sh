#!/usr/bin/env bash
# Compares WaterStudio's C toolkit API (engine/ws-ffi, a drop-in libepanet2) with
# OWA-EPANET's: oracle/toolkit/probe.c calls the API on each network of the corpus and
# our fixtures and prints what every call returns (values at full precision and hashed
# per array); the outputs from the two libraries must be identical (ADR 0016).
#
# Prerequisites: oracle/build.sh, oracle/fetch-corpus.sh, and
#   (cd engine && cargo build --release -p ws-ffi)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
build="$here/.build/toolkit"
ours="$root/engine/target/release"
mkdir -p "$build"

for needed in "$here/.build/lib/libepanet2.so" "$ours/libepanet2.so"; do
  if [[ ! -e "$needed" ]]; then
    echo "error: missing $needed (see the prerequisites at the top of this script)" >&2
    exit 1
  fi
done

cc -O1 -Wall -o "$build/probe-ref" "$here/toolkit/probe.c" -I "$here/.build/src/include" \
   -L "$here/.build/lib" -lepanet2 -Wl,-rpath,"$here/.build/lib" -lm
cc -O1 -Wall -o "$build/probe-ws" "$here/toolkit/probe.c" -I "$here/.build/src/include" \
   -L "$ours" -lepanet2 -Wl,-rpath,"$ours" -lm

mapfile -t networks < <(cd "$here/.corpus" && find . ../fixtures -name '*.inp' -not -path '*/msx-examples/*' -not -path '*/msx/*' | sort)
if [[ ${#networks[@]} -eq 0 ]]; then
  echo "error: no networks in oracle/.corpus; run oracle/fetch-corpus.sh" >&2
  exit 1
fi

# The reference uses glibc's portable pow/exp/log, as compare.py does (ADR 0003).
tunables="glibc.cpu.hwcaps=-AVX2_Usable,-FMA_Usable,-AVX2,-FMA"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
# The probe's reports, output files, saved input files and hydraulics files, kept per
# library with the report's clock times masked.
keep() {
  for f in probe.rpt probe-copy.rpt probe.out probe.inp probe-mutated.inp probe.hyd probe-copy.hyd probe-use.rpt probe-use.out probe-use.inp probe-init.rpt probe-init.inp; do
    if [[ -f "$scratch/$f" ]]; then
      if [[ $f == *.rpt ]]; then
        sed -E 's/[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}/<date>/' "$scratch/$f" > "$scratch/$1.$f"
      elif [[ $f == *.out ]]; then
        cp "$scratch/$f" "$scratch/$1.$f"
        python3 -I "$here/toolkit/outnorm.py" "$scratch/$1.$f"
      else
        cp "$scratch/$f" "$scratch/$1.$f"
      fi
      rm -f "$scratch/$f"
    fi
  done
}
files_match() {
  for f in probe.rpt probe-copy.rpt probe.out probe.inp probe-mutated.inp probe.hyd probe-copy.hyd probe-use.rpt probe-use.out probe-use.inp probe-init.rpt probe-init.inp; do
    if [[ -f "$scratch/ref.$f" || -f "$scratch/ws.$f" ]]; then
      if ! cmp -s "$scratch/ref.$f" "$scratch/ws.$f"; then
        echo "      $f differs"
        diff <(cat -v "$scratch/ref.$f") <(cat -v "$scratch/ws.$f") 2>/dev/null | head -n 6 | cut -c1-160 | sed 's/^/      /' || true
        return 1
      fi
    fi
  done
}

# Known differences: network -> properties whose lines are left out of the comparison.
declare -A known
while read -r net props; do
  [[ -z "$net" || "$net" == \#* ]] && continue
  known[$net]="${props%%#*}"
done < "$here/toolkit-known.txt"

pass=0
fail=0
for net in "${networks[@]}"; do
  inp="$here/.corpus/$net"
  # In the scratch directory: OWA-EPANET makes its temporary files in the current one.
  rm -f "$scratch"/probe*.{rpt,out,inp,hyd} "$scratch"/{ref,ws}.*.{rpt,out,inp,hyd}
  (cd "$scratch" && GLIBC_TUNABLES="$tunables" timeout 600 "$build/probe-ref" "$inp" "$scratch" > ref.txt 2>&1) || true
  keep ref
  (cd "$scratch" && timeout 600 "$build/probe-ws" "$inp" "$scratch" > ws.txt 2>&1) || true
  keep ws
  if [[ -n "${known[$net]:-}" ]]; then
    if cmp -s "$scratch/ref.txt" "$scratch/ws.txt"; then
      printf 'FIXED %s: identical now; remove it from toolkit-known.txt\n' "$net"
      fail=$((fail + 1))
      continue
    fi
    pattern="$(printf ' %s ' ${known[$net]} | sed 's/  */ /g; s/^ //; s/ $//; s/\./\\./g; s/ /|/g')"
    for f in ref ws; do
      grep -Ev " ($pattern) " "$scratch/$f.txt" > "$scratch/$f.filtered" || true
      mv "$scratch/$f.filtered" "$scratch/$f.txt"
    done
  fi
  # The report and output files must be identical too, report dates aside.
  if cmp -s "$scratch/ref.txt" "$scratch/ws.txt" && files_match; then
    pass=$((pass + 1))
    if [[ -n "${known[$net]:-}" ]]; then
      printf 'known %s (%s)\n' "$net" "$(echo ${known[$net]})"
    else
      printf 'ok    %s\n' "$net"
    fi
  else
    fail=$((fail + 1))
    printf 'DIFF  %s\n' "$net"
    diff "$scratch/ref.txt" "$scratch/ws.txt" | head -n 6 | cut -c1-200 | sed 's/^/      /' || true
  fi
done
echo
echo "$pass/$((pass + fail)) networks with identical toolkit results"
[[ $fail -eq 0 ]]
