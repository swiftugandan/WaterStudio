//! Reads `x y` pairs as hex bit patterns on stdin and prints the bits of
//! `pow(x, y)`, `log(x)` and `exp(y)`; `oracle/math-bits.py` compares them with glibc.

#![allow(clippy::unwrap_used)]
use std::io::{BufRead, Write};
fn main() {
    let out = std::io::stdout();
    let mut o = std::io::BufWriter::new(out.lock());
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let mut it = line.split(' ');
        let x = f64::from_bits(u64::from_str_radix(it.next().unwrap(), 16).unwrap());
        let y = f64::from_bits(u64::from_str_radix(it.next().unwrap(), 16).unwrap());
        writeln!(
            o,
            "{:016x} {:016x} {:016x}",
            ws_solver::math::pow(x, y).to_bits(),
            ws_solver::math::log(x).to_bits(),
            ws_solver::math::exp(y).to_bits()
        )
        .unwrap();
    }
}
