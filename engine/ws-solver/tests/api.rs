//! Behaviour of the public API. Numerical agreement with OWA-EPANET is checked to the
//! bit by `oracle/parity.sh`; these tests cover what the corpus cannot.

#![allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]

use ws_solver::{Hydraulics, SolverError, simulate};

const NET: &str = "[JUNCTIONS]\n J1 100 10\n J2 90 20\n[RESERVOIRS]\n R 200\n\
[TANKS]\n T 150 10 0 20 30 0\n\
[PIPES]\n P1 R J1 1000 12 100\n P2 J1 J2 1000 10 100\n P3 J2 T 500 10 100\n\
[TIMES]\n Duration 6:00\n Report Timestep 2:00\n[OPTIONS]\n Units GPM\n[END]\n";

fn model(text: &str) -> ws_model::Model {
    let r = ws_io::read_inp(text);
    assert!(r.errors().next().is_none(), "{:?}", r.issues);
    r.model
}

#[test]
fn reports_every_period_and_conserves_flow() {
    let r = simulate(&model(NET)).unwrap();
    assert_eq!((r.report_start, r.report_step), (0, 7200));
    assert_eq!(r.heads.len(), 4);
    assert_eq!(r.node_ids, ["J1", "J2", "R", "T"]);
    for (d, q) in r.demands.iter().zip(&r.flows) {
        // Junction demand is met by the inflow minus the outflow.
        // (to within the convergence tolerance of the final trial)
        assert!((q[0] - q[1] - d[0]).abs() < 1e-2, "{q:?} {d:?}");
        assert!((q[1] - q[2] - d[1]).abs() < 1e-2, "{q:?} {d:?}");
        // The reservoir's demand is minus its supply.
        assert!((d[2] + q[0]).abs() < 1e-9);
    }
}

#[test]
fn steps_like_the_toolkit() {
    let mut h = Hydraulics::new(&model(NET)).unwrap();
    let mut times = Vec::new();
    loop {
        times.push(h.run().unwrap());
        if h.advance() == 0 {
            break;
        }
    }
    assert_eq!(times.first(), Some(&0));
    assert_eq!(times.last(), Some(&21600));
    assert!(times.windows(2).all(|w| w[0] < w[1]));
}

#[test]
fn rejects_a_malformed_rule_like_epanet() {
    let text = NET.replace(
        "[END]",
        "[RULES]\nRULE 1\nTHEN LINK P1 STATUS IS OPEN\n[END]",
    );
    let err: SolverError = simulate(&model(&text)).unwrap_err();
    assert_eq!(err.code, 200);
}

#[test]
fn rejects_an_unconnected_junction() {
    let text = NET.replace(" J2 90 20\n", " J2 90 20\n J3 80 0\n");
    assert_eq!(simulate(&model(&text)).unwrap_err().code, 233);
}

#[test]
fn rules_close_a_pipe() {
    let text = NET.replace(
        "[END]",
        "[RULES]\nRULE Shut\nIF SYSTEM TIME >= 2:00\nTHEN PIPE P3 STATUS IS CLOSED\n[END]",
    );
    let r = simulate(&model(&text)).unwrap();
    assert!(r.flows[0][2].abs() > 0.0);
    assert_eq!(r.flows[2][2], 0.0);
}

fn with_options(extra: &str) -> String {
    NET.replace("[OPTIONS]\n", &format!("[OPTIONS]\n{extra}"))
}

#[test]
fn no_quality_analysis_leaves_quality_series_empty() {
    let r = simulate(&model(NET)).unwrap();
    assert!(r.node_quality.is_empty() && r.link_quality.is_empty());
}

#[test]
fn traces_the_reservoir_through_the_network() {
    let r = simulate(&model(&with_options(" Quality Trace R\n"))).unwrap();
    assert_eq!(r.node_quality.len(), r.heads.len());
    let first = &r.node_quality[0];
    assert_eq!(first[2], 100.0); // the reservoir itself
    assert_eq!(first[0], 0.0); // nothing has arrived at t = 0
    let last = r.node_quality.last().unwrap();
    assert!(last[0] > 99.0, "{last:?}");
    assert!(r.link_quality.last().unwrap()[0] > 99.0);
}

#[test]
fn water_ages_on_its_way_and_never_ages_at_the_source() {
    let r = simulate(&model(&with_options(" Quality Age\n"))).unwrap();
    let last = r.node_quality.last().unwrap();
    assert_eq!(last[2], 0.0);
    assert!(last[0] > 0.0 && last[1] > last[0], "{last:?}");
}

#[test]
fn quality_runs_need_recorded_hydraulics() {
    let mut h = Hydraulics::new(&model(&with_options(" Quality Age\n"))).unwrap();
    assert!(h.has_quality());
    h.run().unwrap();
    assert_eq!(h.into_quality().unwrap_err().code, 104);
}
