//! `ws-parity <network.inp> <result.json>`
//!
//! Solves the network's hydraulics with the Rust engine and writes every report
//! step at full f64 precision, in the network's own units, keyed by element ID.
//! `oracle/compare.py` reads this file next to OWA-EPANET's binary output.

use std::process::ExitCode;
use std::time::Instant;

use epanet_rs::model::network::Network;
use serde::Serialize;
use ws_study::{HydraulicReport, run_hydraulics};

#[derive(Serialize)]
struct Timed {
    solve_ms: f64,
    #[serde(flatten)]
    report: HydraulicReport,
}

fn run(input: &str, output: &str) -> Result<(), String> {
    let network = Network::from_file(input).map_err(|e| format!("input: {e}"))?;
    let started = Instant::now();
    let report = run_hydraulics(network)?;
    let solve_ms = started.elapsed().as_secs_f64() * 1e3;
    let text =
        serde_json::to_string(&Timed { solve_ms, report }).map_err(|e| format!("encode: {e}"))?;
    std::fs::write(output, text).map_err(|e| format!("write {output}: {e}"))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (Some(input), Some(output)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: ws-parity <network.inp> <result.json>");
        return ExitCode::from(2);
    };
    match run(input, output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
