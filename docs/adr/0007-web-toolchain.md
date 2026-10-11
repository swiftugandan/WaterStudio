# ADR 0007: Web workspace toolchain

- Status: accepted
- Date: 2026-10-11

## Context

Phase 0 needs a JavaScript workspace for the app and its packages (PLAN.md, "Repository layout"). The choices
should be boring, fast and strict, and the dependency tree should resist supply-chain attacks: the app will run
engineers' models locally and, later, agent tools.

## Decision

- **pnpm workspaces**, pinned through `packageManager` and Corepack. Exact versions (`save-exact`), a frozen
  lockfile in CI, `minimumReleaseAge` of one week so a freshly published (possibly hijacked) version is never
  installed, and dependency install scripts disabled except for an allowlist.
- **TypeScript 6.0, strict** with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. TypeScript 7 (the
  native compiler) waits until typescript-eslint supports it (it requires < 6.1 today).
- Packages export their TypeScript sources directly; Vite compiles them. Package code uses only erasable syntax, so
  Node runs build scripts such as `build-tokens.ts` without a compile step.
- **Vite** for the app and workers, **Vitest** for unit tests, **Playwright** with **axe-core** for browser and
  accessibility tests against the production build, **ESLint** (typescript-eslint strict, type-checked) and
  **Prettier** for code (Markdown is left to authors).
- **React only for the shell**, as the plan says; the editor core and renderer stay framework-free.
- Engineering symbols get their own package (`@waterstudio/symbols`) because the renderer worker and the exporters
  use them and must not depend on the React UI package.
- The engine is loaded from `packages/engine-client/wasm/ws_wasm.wasm`, built by `scripts/build-engine.mjs` (or
  copied from the CI engine job's artifact), never committed.

## Consequences

CI gains a `web` job that depends on the engine job's WebAssembly build, so the app is always tested against the
engine on the same commit. Dependency updates arrive at least a week late, by design.
