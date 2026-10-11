// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxtypes.h). See LICENSES/EPANET-MSX.txt.

//! Floating-point helpers with the C source's exact semantics: `pow`, `exp`, `log` and
//! `log10`
//! from the solver's glibc-identical math library (ADR 0003), and the macros of
//! msxtypes.h, which differ from Rust's `abs`/`max`/`min` for negative zero and NaN.

pub use ws_solver::math::{exp, log, log10, pow};

/// `ABS(x)`: keeps the sign of a negative zero.
pub fn abs_c(x: f64) -> f64 {
    if x < 0.0 { -x } else { x }
}

/// `ABS(x)` on a C `float`.
pub fn abs_f32(x: f32) -> f32 {
    if x < 0.0 { -x } else { x }
}

/// `MAX(x, y)`: `x` when `x >= y`, else `y` (so a NaN `x` gives `y`).
pub fn max_c(x: f64, y: f64) -> f64 {
    if x >= y { x } else { y }
}

/// `MIN(x, y)`: `x` when `x <= y`, else `y`.
pub fn min_c(x: f64, y: f64) -> f64 {
    if x <= y { x } else { y }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_macros_keep_signed_zero_and_nan_rules() {
        assert!(abs_c(-0.0).is_sign_negative());
        assert_eq!(max_c(f64::NAN, 0.0), 0.0);
        assert_eq!(min_c(1.0, 2.0), 1.0);
    }
}
