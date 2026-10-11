//! `cargo run --release -p ws-solver --example dump -- <network.inp> [stop-seconds]`
//!
//! Prints every hydraulic time step's heads, flows and statuses at full precision,
//! for comparing step by step with OWA-EPANET's toolkit when a network diverges.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let text = String::from_utf8_lossy(&std::fs::read(&a[1]).unwrap()).to_string();
    let stop: i64 = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(i64::MAX);
    let model = ws_io::read_inp(&text).model;
    let mut h = ws_solver::Hydraulics::new(&model).unwrap();
    let nodes: Vec<String> = h.node_ids().map(String::from).collect();
    let links: Vec<String> = h.link_ids().map(String::from).collect();
    loop {
        let t = h.run().unwrap();
        println!("t {t} convergence {:?}", h.convergence());
        for (id, v) in nodes.iter().zip(h.heads()) {
            println!("N {id} {v:?}");
        }
        for ((id, q), s) in links.iter().zip(h.flows()).zip(h.statuses()) {
            println!("L {id} {q:?} {s:?}");
        }
        if h.advance() <= 0 || t >= stop {
            break;
        }
    }
}
