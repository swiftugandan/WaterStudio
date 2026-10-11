//! `ws-parity [--reference] <network.inp> <result.json>`
//!
//! Solves the network's hydraulics and writes every report period at full f64
//! precision, in the network's own units, keyed by element ID. `oracle/compare.py`
//! reads this file next to OWA-EPANET's binary output.
//!
//! By default the network is solved by WaterStudio's engine (`ws-solver`);
//! `--reference` uses the epanet-rs fork (`ws-hyd`) instead, for benchmarking.

use std::process::ExitCode;
use std::time::Instant;

use serde::Serialize;
use ws_study::{HydraulicReport, run_hydraulics_inp, run_hydraulics_reference};

#[derive(Serialize)]
struct Timed {
    solve_ms: f64,
    #[serde(flatten)]
    report: HydraulicReport,
}

fn run(input: &str, output: &str, reference: bool) -> Result<(), String> {
    let bytes = std::fs::read(input).map_err(|e| format!("read {input}: {e}"))?;
    // EPANET reads bytes; accept files that are not valid UTF-8.
    let text = String::from_utf8_lossy(&bytes);
    let started = Instant::now();
    let report = if reference {
        run_hydraulics_reference(&text)?
    } else {
        run_hydraulics_inp(&text)?
    };
    let solve_ms = started.elapsed().as_secs_f64() * 1e3;
    let text =
        serde_json::to_string(&Timed { solve_ms, report }).map_err(|e| format!("encode: {e}"))?;
    std::fs::write(output, text).map_err(|e| format!("write {output}: {e}"))
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let reference = args.first().is_some_and(|a| a == "--reference");
    if reference {
        args.remove(0);
    }
    let (Some(input), Some(output)) = (args.first(), args.get(1)) else {
        eprintln!("usage: ws-parity [--reference] <network.inp> <result.json>");
        return ExitCode::from(2);
    };
    match run(input, output, reference) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
