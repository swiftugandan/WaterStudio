# WaterStudio

**A modern, open-source studio for designing and analysing drinking-water distribution networks, in your browser.**

WaterStudio aims to do everything [EPA EPANET](https://www.epa.gov/water-research/epanet) does, and more:
extended-period hydraulics and water quality, multi-species chemistry (EPANET-MSX), a CAD-grade network editor
over OpenStreetMap, scenarios, and AI agents that design through the same commands you use and hand back
proposals you review. The calculation engine is written in Rust and runs as WebAssembly on your own device;
your models never leave it unless you choose.

> **Status: pre-alpha, under active construction.** Nothing here is ready for engineering use yet.
> Follow progress in [docs/ROADMAP.md](docs/ROADMAP.md) and the engine's parity with OWA-EPANET in
> [docs/PARITY.md](docs/PARITY.md).

## Design principles

- **Trust the numbers.** Every result is checked against [OWA-EPANET](https://github.com/OpenWaterAnalytics/EPANET),
  the reference engine, on a public corpus of networks, in CI, on every commit.
- **Local-first.** No account and no server needed to model. Projects are files you own.
- **One path for every change.** Clicks, shortcuts, scripts and AI agents all go through one command bus,
  so everything is undoable, validated and attributable.
- **Works everywhere.** WebGPU where it is available, a first-class Canvas 2D fallback where it is not.

## Repository layout

| Path | What it is |
| --- | --- |
| `engine/` | Rust workspace: the hydraulic solver (`ws-hyd`, forked from [epanet-rs](https://github.com/vitens/epanet-rs)), studies (`ws-study`), the WebAssembly boundary (`ws-wasm`) and the parity harness (`ws-parity`) |
| `oracle/` | Builds OWA-EPANET at a pinned release and compares our results with it |
| `scripts/` | Build and verification scripts |
| `docs/` | Plan, roadmap, architecture decisions (`docs/adr/`) and parity reports |

The web app (`apps/web`) and its packages arrive in the following phases; see the roadmap.

## Building

You need [rustup](https://rustup.rs/) (it installs the toolchain pinned in `engine/rust-toolchain.toml`),
Node.js 22 or later, Python 3.10 or later, and CMake with a C compiler for the reference engine.

```sh
cd engine
cargo test                                                   # engine unit tests
cargo build --release                                        # native parity harness
cargo build --release --target wasm32-unknown-unknown -p ws-wasm   # the WebAssembly engine
cd ..
oracle/build.sh                                              # builds OWA-EPANET v2.3.5 into oracle/.build
oracle/fetch-corpus.sh                                       # fetches the test networks into oracle/.corpus
oracle/parity.sh                                             # compares native and WebAssembly engines with OWA-EPANET
```

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). The project follows trunk-based
development: small changes, straight to `main`, always green.

## Licence

Dual-licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
`engine/ws-hyd` is derived from [epanet-rs](https://github.com/vitens/epanet-rs) by Abel Heinsbroek (Vitens N.V.),
under the same dual licence; see [engine/ws-hyd/FORK.md](engine/ws-hyd/FORK.md).

WaterStudio is an independent project. It is not affiliated with or endorsed by the U.S. Environmental Protection
Agency or the Open Water Analytics community.
