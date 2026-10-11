//! `ws`: WaterStudio on the command line.
//!
//!   ws check <net.inp>              report input issues, as EPANET would
//!   ws canon <net.inp> <out.inp>    read and write back in canonical form
//!   ws run <net.inp> <report.rpt> [<out.bin>]
//!                                   run as EPANET's runepanet does: its report and binary output

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

/// The current time as C's `ctime` prints it (UTC), without the newline.
fn ctime_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {} {d:2} {:02}:{:02}:{:02} {y}",
        WD[days.rem_euclid(7) as usize],
        MO[(m - 1) as usize],
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn run(input: &str, rpt: &str, out: Option<&str>) -> Result<bool, String> {
    let r = read_inp(&read_text(input)?);
    if let Some(issue) = r.errors().next() {
        return Err(format!("{input}:{}: {}", issue.line, issue.message));
    }
    let opts = ws_solver::RunOptions {
        inp_name: input.to_string(),
        date: ctime_now(),
        report: true,
        status_log: false,
    };
    let run = ws_solver::run_epanet(&r.model, &opts, |_| {}).map_err(|e| e.to_string())?;
    std::fs::write(rpt, run.report().unwrap_or_default()).map_err(|e| format!("{rpt}: {e}"))?;
    if let Some(out) = out {
        std::fs::write(out, run.out_file()).map_err(|e| format!("{out}: {e}"))?;
    }
    Ok(true)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let outcome = match refs.as_slice() {
        ["check", path] => check(path),
        ["canon", input, output] => canon(input, output),
        ["run", input, rpt] => run(input, rpt, None),
        ["run", input, rpt, out] => run(input, rpt, Some(out)),
        _ => {
            eprintln!(
                "usage: ws check <net.inp> | ws canon <net.inp> <out.inp> | ws run <net.inp> <report.rpt> [<out.bin>]"
            );
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
