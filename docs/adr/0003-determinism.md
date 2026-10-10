# ADR 0003: Native and WebAssembly builds must give bit-identical results

- Status: accepted (not yet met)
- Date: 2026-10-10

## Context

Run records will carry hashes of results so any run can be reproduced and audited. That requires the same
inputs to give the same bits on every device and in both builds. The spike found native and WebAssembly results
differing in late digits on 32 of 54 networks (heads up to 1e-8 relative; flows more on poorly conditioned
networks, within the solver's convergence slack).

Likely causes: the native build calls the platform's `libm` while wasm32 uses Rust's own; faer dispatches to
AVX2/FMA kernels at run time on x86; fused multiply-add changes rounding.

## Decision

Make results bit-identical across builds by using one implementation of each transcendental function (the `libm`
crate) everywhere, disabling faer's runtime SIMD dispatch in favour of one fixed code path per build, and
forbidding FMA contraction. `scripts/check-wasm.mjs` becomes a CI gate once met.

## Consequences

Some native speed is given up. Parity with OWA-EPANET (ADR 0002) is unaffected: it is measured within tolerance,
not bit for bit.
