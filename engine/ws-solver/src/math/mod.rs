// SPDX-License-Identifier: MIT OR Apache-2.0 WITH LLVM-exception
// Ported from ARM optimized-routines (math/pow.c, exp.c, log.c), Copyright (c)
// 2018-2026, Arm Limited. See LICENSES/ARM-optimized-routines.txt.

//! `pow`, `exp`, `log` and `log10` that return the same bits on every platform.
//!
//! These are ARM optimized-routines' algorithms — the same code glibc uses for
//! `pow`, `exp` and `log` — on the path without fused multiply-add, which is what
//! glibc runs on a CPU without FMA. Rust never contracts `a * b + c` into an FMA, so
//! this port gives identical results natively and in WebAssembly, and identical
//! results to OWA-EPANET built against glibc when glibc is kept off its FMA variants
//! (ADR 0003; `oracle/compare.py` sets `GLIBC_TUNABLES` for this).
//!
//! Error handling follows the library built without errno: overflow gives ±inf,
//! underflow ±0 and an invalid operation NaN.

#![allow(clippy::excessive_precision, clippy::unreadable_literal)]

mod tables;

// Hexadecimal float constants from the C source (Rust has no hex float literals).
/// 0x1.09p-4
const H_1_09M4: f64 = f64::from_bits(0x3fb0900000000000);
/// 0x1p-1022
const H_1M1022: f64 = f64::from_bits(0x0010000000000000);
/// 0x1p-4
const H_1M4: f64 = f64::from_bits(0x3fb0000000000000);
/// 0x1p-54
const H_1M54: f64 = f64::from_bits(0x3c90000000000000);
/// 0x1p-767
const H_1M767: f64 = f64::from_bits(0x1000000000000000);
/// 0x1p1009
const H_1P1009: f64 = f64::from_bits(0x7f00000000000000);
/// 0x1p27
const H_1P27: f64 = f64::from_bits(0x41a0000000000000);
/// 0x1p52
const H_1P52: f64 = f64::from_bits(0x4330000000000000);
/// 0x1p769
const H_1P769: f64 = f64::from_bits(0x7000000000000000);

use tables::*;

#[inline(always)]
fn asuint64(x: f64) -> u64 {
    x.to_bits()
}

#[inline(always)]
fn asdouble(i: u64) -> f64 {
    f64::from_bits(i)
}

#[inline(always)]
fn top12(x: f64) -> u32 {
    (asuint64(x) >> 52) as u32
}

#[inline(always)]
fn d(bits: u64) -> f64 {
    f64::from_bits(bits)
}

fn math_oflow(sign: u32) -> f64 {
    let y = H_1P769 * H_1P769;
    if sign != 0 { -y } else { y }
}

fn math_uflow(sign: u32) -> f64 {
    let y = H_1M767 * H_1M767;
    if sign != 0 { -y } else { y }
}

#[allow(clippy::eq_op)]
fn math_invalid(x: f64) -> f64 {
    (x - x) / (x - x)
}

const EXP_TABLE_BITS: u32 = 7;
const EXP_N: u64 = 1 << EXP_TABLE_BITS;
const POW_LOG_TABLE_BITS: u32 = 7;
const POW_N: u64 = 1 << POW_LOG_TABLE_BITS;
const LOG_TABLE_BITS: u32 = 7;
const LOG_N: u64 = 1 << LOG_TABLE_BITS;
const SIGN_BIAS: u32 = 0x800 << EXP_TABLE_BITS;

/// log(x) as y + tail, with about 15 extra bits in tail (`log_inline` in pow.c).
#[inline(always)]
fn pow_log_inline(ix: u64) -> (f64, f64) {
    const OFF: u64 = 0x3fe6955500000000;
    let tmp = ix.wrapping_sub(OFF);
    let i = ((tmp >> (52 - POW_LOG_TABLE_BITS)) % POW_N) as usize;
    let k = (tmp as i64) >> 52;
    let iz = ix.wrapping_sub(tmp & (0xfffu64 << 52));
    let z = asdouble(iz);
    let kd = k as f64;

    let invc = d(POW_TAB[4 * i]);
    let logc = d(POW_TAB[4 * i + 2]);
    let logctail = d(POW_TAB[4 * i + 3]);

    // Split z such that rhi, rlo and rhi*rhi are exact and |rlo| <= |r|.
    let zhi = asdouble(iz.wrapping_add(1u64 << 31) & (u64::MAX << 32));
    let zlo = z - zhi;
    let rhi = zhi * invc - 1.0;
    let rlo = zlo * invc;
    let r = rhi + rlo;

    let t1 = kd * d(POW_LN2HI) + logc;
    let t2 = t1 + r;
    let lo1 = kd * d(POW_LN2LO) + logctail;
    let lo2 = t1 - t2 + r;

    let a = |j: usize| d(POW_POLY[j]);
    let ar = a(0) * r;
    let ar2 = r * ar;
    let ar3 = r * ar2;
    let arhi = a(0) * rhi;
    let arhi2 = rhi * arhi;
    let hi = t2 + arhi2;
    let lo3 = rlo * (ar + arhi);
    let lo4 = t2 - hi + arhi2;
    let p = ar3 * (a(1) + r * a(2) + ar2 * (a(3) + r * a(4) + ar2 * (a(5) + r * a(6))));
    let lo = lo1 + lo2 + lo3 + lo4 + p;
    let y = hi + lo;
    let tail = hi - y + lo;
    (y, tail)
}

/// `specialcase` in pow.c: scale*(1+tmp) where the result may over- or underflow.
fn pow_specialcase(tmp: f64, mut sbits: u64, ki: u64) -> f64 {
    if ki & 0x80000000 == 0 {
        sbits = sbits.wrapping_sub(1009u64 << 52);
        let scale = asdouble(sbits);
        let y = scale + scale * tmp;
        return y * H_1P1009;
    }
    sbits = sbits.wrapping_add(1022u64 << 52);
    let scale = asdouble(sbits);
    let mut y = scale + scale * tmp;
    if y.abs() < 1.0 {
        let one = if y < 0.0 { -1.0 } else { 1.0 };
        let mut lo = scale - y + scale * tmp;
        let hi = one + y;
        lo = one - hi + y + lo;
        y = (hi + lo) - one;
        if y == 0.0 {
            y = asdouble(sbits & 0x8000000000000000);
        }
    }
    H_1M1022 * y
}

/// `specialcase` in exp.c.
fn exp_specialcase(tmp: f64, mut sbits: u64, ki: u64) -> f64 {
    if ki & 0x80000000 == 0 {
        sbits = sbits.wrapping_sub(1009u64 << 52);
        let scale = asdouble(sbits);
        return H_1P1009 * (scale + scale * tmp);
    }
    sbits = sbits.wrapping_add(1022u64 << 52);
    let scale = asdouble(sbits);
    let mut y = scale + scale * tmp;
    if y < 1.0 {
        let mut lo = scale - y + scale * tmp;
        let hi = 1.0 + y;
        lo = 1.0 - hi + y + lo;
        y = (hi + lo) - 1.0;
        if y == 0.0 {
            y = 0.0;
        }
    }
    H_1M1022 * y
}

/// The shared core of `exp_inline` in pow.c and exp.c. `xtail` is `None` for exp.
#[inline(always)]
fn exp_core(x: f64, xtail: Option<f64>, sign_bias: u32) -> (f64, u64, u64) {
    let z = d(EXP_INVLN2N) * x;
    let mut kd = z + d(EXP_SHIFT);
    let ki = asuint64(kd);
    kd -= d(EXP_SHIFT);
    let mut r = x + kd * d(EXP_NEGLN2HIN) + kd * d(EXP_NEGLN2LON);
    if let Some(t) = xtail {
        r += t;
    }
    let idx = (2 * (ki % EXP_N)) as usize;
    let top = ki.wrapping_add(sign_bias as u64) << (52 - EXP_TABLE_BITS);
    let tail = asdouble(EXP_TAB[idx]);
    let sbits = EXP_TAB[idx + 1].wrapping_add(top);
    let r2 = r * r;
    let c = |j: usize| d(EXP_POLY[j]);
    // EXP_POLY_ORDER == 5: C2..C5 are poly[0..4].
    let tmp = tail + r + r2 * (c(0) + r * c(1)) + r2 * r2 * (c(2) + r * c(3));
    (tmp, sbits, ki)
}

#[inline(always)]
fn pow_exp_inline(x: f64, xtail: f64, sign_bias: u32) -> f64 {
    let mut abstop = top12(x) & 0x7ff;
    if abstop.wrapping_sub(top12(H_1M54)) >= top12(512.0).wrapping_sub(top12(H_1M54)) {
        if abstop.wrapping_sub(top12(H_1M54)) >= 0x80000000 {
            let one = 1.0 + x;
            return if sign_bias != 0 { -one } else { one };
        }
        if abstop >= top12(1024.0) {
            return if asuint64(x) >> 63 != 0 {
                math_uflow(sign_bias)
            } else {
                math_oflow(sign_bias)
            };
        }
        abstop = 0;
    }
    let (tmp, sbits, ki) = exp_core(x, Some(xtail), sign_bias);
    if abstop == 0 {
        return pow_specialcase(tmp, sbits, ki);
    }
    let scale = asdouble(sbits);
    scale + scale * tmp
}

/// `checkint`: 0 if not an integer, 1 if odd, 2 if even.
fn checkint(iy: u64) -> i32 {
    let e = (iy >> 52 & 0x7ff) as i32;
    if e < 0x3ff {
        return 0;
    }
    if e > 0x3ff + 52 {
        return 2;
    }
    let sh = (0x3ff + 52 - e) as u32;
    if iy & ((1u64 << sh) - 1) != 0 {
        return 0;
    }
    if iy & (1u64 << sh) != 0 {
        return 1;
    }
    2
}

fn zeroinfnan(i: u64) -> bool {
    (2u64.wrapping_mul(i)).wrapping_sub(1)
        >= (2u64.wrapping_mul(asuint64(f64::INFINITY))).wrapping_sub(1)
}

/// x raised to the power y.
pub fn pow(x: f64, y: f64) -> f64 {
    let mut sign_bias = 0u32;
    let mut ix = asuint64(x);
    let iy = asuint64(y);
    let mut topx = top12(x);
    let topy = top12(y);
    if topx.wrapping_sub(0x001) >= 0x7ff - 0x001
        || (topy & 0x7ff).wrapping_sub(0x3be) >= 0x43e - 0x3be
    {
        if zeroinfnan(iy) {
            if iy.wrapping_mul(2) == 0 {
                return if is_signaling(x) { x + y } else { 1.0 };
            }
            if ix == asuint64(1.0) {
                return if is_signaling(y) { x + y } else { 1.0 };
            }
            let inf2 = asuint64(f64::INFINITY).wrapping_mul(2);
            if ix.wrapping_mul(2) > inf2 || iy.wrapping_mul(2) > inf2 {
                return x + y;
            }
            if ix.wrapping_mul(2) == asuint64(1.0).wrapping_mul(2) {
                return 1.0;
            }
            if (ix.wrapping_mul(2) < asuint64(1.0).wrapping_mul(2)) == (iy >> 63 == 0) {
                return 0.0;
            }
            return y * y;
        }
        if zeroinfnan(ix) {
            let mut x2 = x * x;
            if ix >> 63 != 0 && checkint(iy) == 1 {
                x2 = -x2;
            }
            return if iy >> 63 != 0 { 1.0 / x2 } else { x2 };
        }
        // Here x and y are non-zero finite.
        if ix >> 63 != 0 {
            let yint = checkint(iy);
            if yint == 0 {
                return math_invalid(x);
            }
            if yint == 1 {
                sign_bias = SIGN_BIAS;
            }
            ix &= 0x7fffffffffffffff;
            topx &= 0x7ff;
        }
        if (topy & 0x7ff).wrapping_sub(0x3be) >= 0x43e - 0x3be {
            if ix == asuint64(1.0) {
                return 1.0;
            }
            if (topy & 0x7ff) < 0x3be {
                return if ix > asuint64(1.0) { 1.0 + y } else { 1.0 - y };
            }
            return if (ix > asuint64(1.0)) == (topy < 0x800) {
                math_oflow(0)
            } else {
                math_uflow(0)
            };
        }
        if topx == 0 {
            // Normalise subnormal x so its exponent becomes negative.
            ix = asuint64(x * H_1P52);
            ix &= 0x7fffffffffffffff;
            ix = ix.wrapping_sub(52u64 << 52);
        }
    }

    let (hi, lo) = pow_log_inline(ix);
    let yhi = asdouble(iy & (u64::MAX << 27));
    let ylo = y - yhi;
    let lhi = asdouble(asuint64(hi) & (u64::MAX << 27));
    let llo = hi - lhi + lo;
    let ehi = yhi * lhi;
    let elo = ylo * lhi + y * llo;
    pow_exp_inline(ehi, elo, sign_bias)
}

fn is_signaling(x: f64) -> bool {
    // Quiet bit clear on a NaN.
    x.is_nan() && (asuint64(x) & (1u64 << 51)) == 0
}

/// e raised to the power x.
pub fn exp(x: f64) -> f64 {
    let mut abstop = top12(x) & 0x7ff;
    if abstop.wrapping_sub(top12(H_1M54)) >= top12(512.0).wrapping_sub(top12(H_1M54)) {
        if abstop.wrapping_sub(top12(H_1M54)) >= 0x80000000 {
            return 1.0 + x;
        }
        if abstop >= top12(1024.0) {
            if asuint64(x) == asuint64(f64::NEG_INFINITY) {
                return 0.0;
            }
            if abstop >= top12(f64::INFINITY) {
                return 1.0 + x;
            }
            return if asuint64(x) >> 63 != 0 {
                math_uflow(0)
            } else {
                math_oflow(0)
            };
        }
        abstop = 0;
    }
    let (tmp, sbits, ki) = exp_core(x, None, 0);
    if abstop == 0 {
        return exp_specialcase(tmp, sbits, ki);
    }
    let scale = asdouble(sbits);
    scale + scale * tmp
}

/// Natural logarithm.
pub fn log(x: f64) -> f64 {
    const OFF: u64 = 0x3fe6000000000000;
    let mut ix = asuint64(x);
    let top = (ix >> 48) as u32;
    let lo_b = asuint64(1.0 - H_1M4);
    let hi_b = asuint64(1.0 + H_1_09M4);
    if ix.wrapping_sub(lo_b) < hi_b - lo_b {
        if ix == asuint64(1.0) {
            return 0.0;
        }
        let b = |j: usize| d(LOG_POLY1[j]);
        let r = x - 1.0;
        let r2 = r * r;
        let r3 = r * r2;
        let mut y = r3
            * (b(1)
                + r * b(2)
                + r2 * b(3)
                + r3 * (b(4)
                    + r * b(5)
                    + r2 * b(6)
                    + r3 * (b(7) + r * b(8) + r2 * b(9) + r3 * b(10))));
        // N > 64: worst-case error around 0.507 ULP.
        let mut w = r * H_1P27;
        let rhi = r + w - w;
        let rlo = r - rhi;
        w = rhi * rhi * b(0);
        let hi = r + w;
        let mut lo = r - hi + w;
        lo += b(0) * rlo * (rhi + r);
        y += lo;
        y += hi;
        return y;
    }
    if top.wrapping_sub(0x0010) >= 0x7ff0 - 0x0010 {
        if ix.wrapping_mul(2) == 0 {
            return -1.0 / 0.0;
        }
        if ix == asuint64(f64::INFINITY) {
            return x;
        }
        if (top & 0x8000) != 0 || (top & 0x7ff0) == 0x7ff0 {
            return math_invalid(x);
        }
        ix = asuint64(x * H_1P52);
        ix = ix.wrapping_sub(52u64 << 52);
    }
    let tmp = ix.wrapping_sub(OFF);
    let i = ((tmp >> (52 - LOG_TABLE_BITS)) % LOG_N) as usize;
    let k = (tmp as i64) >> 52;
    let iz = ix.wrapping_sub(tmp & (0xfffu64 << 52));
    let invc = d(LOG_TAB[2 * i]);
    let logc = d(LOG_TAB[2 * i + 1]);
    let z = asdouble(iz);
    let r = (z - d(LOG_TAB2[2 * i]) - d(LOG_TAB2[2 * i + 1])) * invc;
    let kd = k as f64;
    let w = kd * d(LOG_LN2HI) + logc;
    let hi = w + r;
    let lo = w - hi + r + kd * d(LOG_LN2LO);
    let r2 = r * r;
    let a = |j: usize| d(LOG_POLY[j]);
    lo + r2 * a(0) + r * r2 * (a(1) + r * a(2) + r2 * (a(3) + r * a(4))) + hi
}

/// Base-10 logarithm: glibc's `__ieee754_log10` (an fdlibm algorithm) on top of
/// [`log`], so it returns glibc's bits too.
pub fn log10(x: f64) -> f64 {
    const TWO54: f64 = 1.801_439_850_948_198_4e16; // 0x4350000000000000
    const IVLN10: f64 = f64::from_bits(0x3FDB_CB7B_1526_E50E);
    const LOG10_2HI: f64 = f64::from_bits(0x3FD3_4413_509F_6000);
    const LOG10_2LO: f64 = f64::from_bits(0x3D59_FEF3_11F1_2B36);
    let bits = x.to_bits();
    let mut hx = (bits >> 32) as i32;
    let lx = bits as u32;
    let mut k: i32 = 0;
    let mut x = x;
    if hx < 0x0010_0000 {
        // x < 2**-1022
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return -TWO54 / 0.0; // log(+-0) = -inf
        }
        if hx < 0 {
            return f64::NAN; // log(-#) = NaN (only ever turned into 0 by the evaluator)
        }
        k -= 54;
        x *= TWO54; // subnormal number, scale up x
        hx = (x.to_bits() >> 32) as i32;
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    let i = ((k as u32) & 0x8000_0000) >> 31;
    hx = (hx & 0x000f_ffff) | (((0x3ff - i) as i32) << 20);
    let y = f64::from(k + i as i32);
    let x = f64::from_bits((u64::from(hx as u32) << 32) | u64::from(x.to_bits() as u32));
    let z = y * LOG10_2LO + IVLN10 * log(x);
    z + y * LOG10_2HI
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn exact_cases() {
        assert_eq!(pow(2.0, 10.0), 1024.0);
        assert_eq!(pow(9.0, 0.5), 3.0);
        assert_eq!(pow(-2.0, 3.0), -8.0);
        assert!(pow(-2.0, 0.5).is_nan());
        assert_eq!(pow(0.0, -1.0), f64::INFINITY);
        assert_eq!(pow(1.0, f64::NAN), 1.0);
        assert_eq!(exp(0.0), 1.0);
        assert_eq!(log(1.0), 0.0);
        assert_eq!(log(0.0), f64::NEG_INFINITY);
        assert!(log(-1.0).is_nan());
        assert_eq!(exp(1000.0), f64::INFINITY);
        assert_eq!(exp(-1000.0), 0.0);
    }

    #[test]
    fn close_to_std() {
        let mut s = 0x1234_5678_9abc_def0u64;
        for _ in 0..100_000 {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let x = (s >> 11) as f64 / (1u64 << 53) as f64 * 1000.0 + 1e-6;
            let y = ((s >> 3) % 4000) as f64 / 1000.0 - 2.0;
            let rel = |a: f64, b: f64| ((a - b) / b).abs();
            assert!(rel(pow(x, y), x.powf(y)) < 3e-16, "pow({x}, {y})");
            assert!(
                rel(log(x), x.ln()) < 3e-16 || (log(x) - x.ln()).abs() < 1e-300,
                "log({x})"
            );
            assert!(rel(exp(y * 10.0), (y * 10.0).exp()) < 3e-16, "exp({y})");
        }
    }

    #[test]
    fn log10_of_powers_of_ten_is_exact() {
        for p in -20..=20 {
            assert_eq!(log10(10f64.powi(p)), f64::from(p), "10^{p}");
        }
        assert_eq!(log10(0.0), f64::NEG_INFINITY);
        assert!(log10(-1.0).is_nan());
    }
}
