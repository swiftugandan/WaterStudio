# Headers

`epanet2_2.h` and `epanet2_enums.h` are OWA-EPANET 2.3.5's, unchanged (MIT licence, see
`LICENSES/OWA-EPANET.txt`). Programs written for OWA-EPANET compile against them and link
against WaterStudio's `libepanet2` (`cargo build --release -p ws-ffi`) instead of OWA's.

ADR 0016 lists which functions are implemented so far. The legacy single-precision API
(`epanet2.h`, `ENopen` and friends) is not yet.
