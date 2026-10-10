//! `ws`: WaterStudio on the command line.
//!
//!   ws check <net.inp>              report input issues, as EPANET would
//!   ws canon <net.inp> <out.inp>    read and write back in canonical form

use std::process::ExitCode;

use ws_io::{Severity, read_inp, write_inp};

fn read_text(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    // Older files are often Latin-1; keep going with replacement characters.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn check(path: &str) -> Result<bool, String> {
    let r = read_inp(&read_text(path)?);
    for i in &r.issues {
        let level = match i.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        println!("{path}:{}: {level}: {} {}", i.line, i.section, i.message);
    }
    let m = &r.model;
    println!(
        "{} nodes, {} links, {} patterns, {} curves, {} controls, {} rules",
        m.nodes.len(),
        m.links.len(),
        m.patterns.len(),
        m.curves.len(),
        m.controls.len(),
        m.rules.len()
    );
    Ok(r.errors().next().is_none())
}

fn canon(input: &str, output: &str) -> Result<bool, String> {
    let r = read_inp(&read_text(input)?);
    std::fs::write(output, write_inp(&r.model)).map_err(|e| format!("{output}: {e}"))?;
    Ok(true)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let outcome = match refs.as_slice() {
        ["check", path] => check(path),
        ["canon", input, output] => canon(input, output),
        _ => {
            eprintln!("usage: ws check <net.inp> | ws canon <net.inp> <out.inp>");
            return ExitCode::from(2);
        }
    };
    match outcome {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
