//! The few C `printf` conversions EPANET's report uses, reproduced exactly: `%.Nf`,
//! `%.Ne`, `%s` and `%d`, with field widths and left justification.
//!
//! Rust's `{:.N}` rounds the exact binary value half to even, as glibc does, so only
//! exponents, non-finite values and padding need care.

/// `%.{prec}f`
pub fn f(v: f64, prec: usize) -> String {
    if !v.is_finite() {
        return nonfinite(v);
    }
    format!("{v:.prec$}")
}

/// `%.{prec}e`
pub fn e(v: f64, prec: usize) -> String {
    if !v.is_finite() {
        return nonfinite(v);
    }
    let s = format!("{v:.prec$e}");
    let (mant, exp) = s.split_once('e').unwrap_or((&s, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let sign = if exp < 0 { '-' } else { '+' };
    format!("{mant}e{sign}{:02}", exp.unsigned_abs())
}

fn nonfinite(v: f64) -> String {
    let neg = v.is_sign_negative();
    let body = if v.is_nan() { "nan" } else { "inf" };
    if neg {
        format!("-{body}")
    } else {
        body.to_string()
    }
}

/// Right-justify in a field of `w` characters (`%{w}s`).
pub fn r(s: &str, w: usize) -> String {
    format!("{s:>w$}")
}

/// Left-justify in a field of `w` characters (`%-{w}s`).
pub fn l(s: &str, w: usize) -> String {
    format!("{s:<w$}")
}

/// `%.{n}s`: at most `n` bytes (EPANET's text is ASCII).
pub fn trunc(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_glibc() {
        assert_eq!(f(0.125, 2), "0.12");
        assert_eq!(f(2.5, 0), "2");
        assert_eq!(f(-0.0, 2), "-0.00");
        assert_eq!(e(12345.6789, 3), "1.235e+04");
        assert_eq!(e(1e-7, 5), "1.00000e-07");
        assert_eq!(e(0.0, 2), "0.00e+00");
        assert_eq!(e(1.5e123, 2), "1.50e+123");
        assert_eq!(f(f64::NAN, 2), "nan");
        assert_eq!(r("ab", 5), "   ab");
        assert_eq!(l("ab", 5), "ab   ");
        assert_eq!(trunc("abcdef", 3), "abc");
    }
}
