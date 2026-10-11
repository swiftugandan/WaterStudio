//! Fire flow and criticality on EPANET's Net1.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ws_study::studies::{CriticalityOptions, FireFlowOptions, criticality, fire_flow};

fn net1() -> ws_model::Model {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/web/public/samples/Net1.inp"
    ))
    .unwrap();
    ws_io::read_inp(&text).model
}

#[test]
fn fire_flow_finds_the_flow_at_the_residual_pressure() {
    let m = net1();
    let opts = FireFlowOptions {
        hydrants: vec!["32".into(), "22".into(), "9".into()],
        flow: 500.0,
        residual: 20.0,
        system_min: None,
        time: 0,
        max_flow: Some(20000.0),
    };
    let r = fire_flow(&m, &opts).unwrap();
    assert_eq!(r.len(), 3);
    let h = &r[0];
    assert!(h.residual_pressure < h.static_pressure, "{h:?}");
    assert!(h.meets, "{h:?}");
    assert!(h.available_flow > 500.0, "{h:?}");
    // At the available flow the residual pressure is the limit.
    let at = fire_flow(
        &m,
        &FireFlowOptions {
            flow: h.available_flow,
            hydrants: vec!["32".into()],
            ..opts.clone()
        },
    )
    .unwrap();
    assert!((at[0].residual_pressure - 20.0).abs() < 0.5, "{:?}", at[0]);
    // A reservoir is not a hydrant.
    assert!(r[2].error.is_some());
    // A system limit lowers the available flow.
    let strict = fire_flow(
        &m,
        &FireFlowOptions {
            system_min: Some(100.0),
            hydrants: vec!["32".into()],
            ..opts
        },
    )
    .unwrap();
    assert!(strict[0].available_flow < h.available_flow);
}

#[test]
fn criticality_ranks_the_main_above_a_loop_pipe() {
    let m = net1();
    let r = criticality(
        &m,
        &CriticalityOptions {
            links: vec!["10".into(), "111".into(), "nope".into()],
            pressure: 100.0,
        },
    )
    .unwrap();
    assert_eq!(r.len(), 3);
    let main = &r[0];
    let looped = &r[1];
    assert!(
        main.failed || main.min_pressure < looped.min_pressure,
        "{main:?} {looped:?}"
    );
    assert!(!looped.failed, "{looped:?}");
    assert!(r[2].failed);
    // Every pipe when none are named.
    let all = criticality(
        &m,
        &CriticalityOptions {
            links: vec![],
            pressure: 100.0,
        },
    )
    .unwrap();
    assert_eq!(all.len(), 12);
}
