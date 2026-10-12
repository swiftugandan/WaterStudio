//! Times the fire-flow study: `cargo run --release -p ws-study --example fireflow -- net.inp [every]`
//! runs it at every `every`-th junction (default 10) and prints the time and a checksum.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use ws_study::studies::{FireFlowOptions, fire_flow};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let text = std::fs::read_to_string(&args[1]).expect("read the network");
    let every: usize = args.get(2).map_or(10, |s| s.parse().unwrap());
    let model = ws_io::read_inp(&text).model;
    if std::env::var("TRIALS").is_ok() {
        trials(&model);
        return;
    }
    let hydrants: Vec<String> = model
        .nodes
        .iter()
        .filter(|n| matches!(n.kind, ws_model::NodeKind::Junction(_)))
        .map(|n| n.id.clone())
        .step_by(every)
        .collect();
    let opts = FireFlowOptions {
        hydrants: hydrants.clone(),
        flow: 500.0,
        residual: 20.0,
        system_min: None,
        time: 0,
        max_flow: None,
    };
    let t0 = std::time::Instant::now();
    let r = fire_flow(&model, &opts).expect("fire flow");
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let sum: f64 = r.iter().map(|x| x.available_flow).sum();
    println!(
        "{} hydrants in {ms:.0} ms ({:.1} ms each); total available flow {sum:.3}",
        r.len(),
        ms / r.len() as f64
    );
    for x in r.iter().take(5) {
        println!(
            "  {} static {:.3} residual {:.3} available {:.3} meets {}",
            x.id, x.static_pressure, x.residual_pressure, x.available_flow, x.meets
        );
    }
}

#[allow(dead_code)]
fn trials(model: &ws_model::Model) {
    let mut base = ws_solver::Hydraulics::new(model).unwrap();
    base.run().unwrap();
    println!("base trials {:?}", base.convergence());
    let mut h = base.clone();
    for q in [500.0, 5000.0, 2500.0] {
        let t0 = std::time::Instant::now();
        h.set_constant_demand(5050, q).unwrap();
        h.run().unwrap();
        println!(
            "q {q}: {:?} in {:.1} ms",
            h.convergence(),
            t0.elapsed().as_secs_f64() * 1000.0
        );
    }
    let t0 = std::time::Instant::now();
    let c = base.clone();
    println!("clone {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0);
    drop(c);
}
