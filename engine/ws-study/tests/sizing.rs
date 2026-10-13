//! Least-cost pipe sizing and fire-flow repair on EPANET's Net1.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ws_study::sizing::{FireDemand, Limits, PipeSize, SizingOptions, size_pipes};
use ws_study::studies::{FireFlowOptions, fire_flow};

fn net1() -> ws_model::Model {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../apps/web/public/samples/Net1.inp"
    ))
    .unwrap();
    ws_io::read_inp(&text).model
}

/// US standard sizes (in) with an illustrative installed cost per foot.
fn sizes() -> Vec<PipeSize> {
    [
        (6.0, 50.0),
        (8.0, 60.0),
        (10.0, 75.0),
        (12.0, 90.0),
        (14.0, 110.0),
        (16.0, 130.0),
        (18.0, 150.0),
        (20.0, 170.0),
        (24.0, 210.0),
    ]
    .into_iter()
    .map(|(diameter, unit_cost)| PipeSize {
        diameter,
        unit_cost,
    })
    .collect()
}

fn pipes(m: &ws_model::Model) -> Vec<String> {
    m.links
        .iter()
        .filter(|l| matches!(l.kind, ws_model::LinkKind::Pipe(_)))
        .map(|l| l.id.clone())
        .collect()
}

fn opts(m: &ws_model::Model) -> SizingOptions {
    SizingOptions {
        pipes: pipes(m),
        sizes: sizes(),
        limits: Limits {
            min_pressure: Some(108.0),
            max_pressure: None,
            max_velocity: Some(2.5),
            max_headloss: Some(3.0),
        },
        fire: None,
        from_smallest: false,
        max_solutions: None,
    }
}

#[test]
fn sizes_pipes_to_meet_the_limits() {
    let m = net1();
    let r = size_pipes(&m, &opts(&m)).unwrap();
    eprintln!("{r:#?}");
    assert!(!r.before.is_empty());
    assert!(r.meets, "{r:?}");
    assert!(r.after.is_empty());
    assert!(r.changes.iter().all(|c| c.to > c.from), "{r:?}");
    // Apply the design and check it independently over the whole simulation.
    let mut sized = m.clone();
    for c in &r.changes {
        let l = sized.links.iter_mut().find(|l| l.id == c.id).unwrap();
        if let ws_model::LinkKind::Pipe(p) = &mut l.kind {
            p.diameter = c.to;
        }
    }
    let run = ws_study::run::run_model(&sized, None).unwrap();
    let periods = run.periods();
    let (p, v, hl) = (2, 1, 2);
    for k in 0..periods {
        for (i, n) in sized.nodes.iter().enumerate() {
            if matches!(n.kind, ws_model::NodeKind::Junction(_)) {
                assert!(
                    run.nodes[p][k * run.node_count + i] >= 108.0,
                    "{} at {k}",
                    n.id
                );
            }
        }
        for (i, l) in sized.links.iter().enumerate() {
            if matches!(l.kind, ws_model::LinkKind::Pipe(_)) {
                assert!(
                    run.links[v][k * run.link_count + i] <= 2.5,
                    "{} at {k}",
                    l.id
                );
                assert!(
                    run.links[hl][k * run.link_count + i] <= 3.0,
                    "{} at {k}",
                    l.id
                );
            }
        }
    }
    // Nothing is larger than it needs to be: stepping any change down breaks a limit.
    let again = size_pipes(&sized, &opts(&sized)).unwrap();
    assert!(again.changes.is_empty() && again.meets && again.cost == 0.0);
}

#[test]
fn repairs_fire_flow() {
    let m = net1();
    let hydrants: Vec<String> = ["22", "23", "32"].iter().map(|s| (*s).into()).collect();
    let flow = 2500.0;
    let study = fire_flow(
        &m,
        &FireFlowOptions {
            hydrants: hydrants.clone(),
            flow,
            residual: 20.0,
            system_min: Some(20.0),
            time: 0,
            max_flow: None,
        },
    )
    .unwrap();
    eprintln!("{study:#?}");
    let failing: Vec<String> = study
        .iter()
        .filter(|r| !r.meets)
        .map(|r| r.id.clone())
        .collect();
    assert!(!failing.is_empty());
    let o = SizingOptions {
        limits: Limits::default(),
        fire: Some(FireDemand {
            hydrants: failing.clone(),
            flow,
            residual: 20.0,
            system_min: Some(20.0),
            time: 0,
        }),
        ..opts(&m)
    };
    let r = size_pipes(&m, &o).unwrap();
    eprintln!("{r:#?}");
    assert!(r.meets, "{r:?}");
    let mut sized = m.clone();
    for c in &r.changes {
        let l = sized.links.iter_mut().find(|l| l.id == c.id).unwrap();
        if let ws_model::LinkKind::Pipe(p) = &mut l.kind {
            p.diameter = c.to;
        }
    }
    let after = fire_flow(
        &sized,
        &FireFlowOptions {
            hydrants: failing,
            flow,
            residual: 20.0,
            system_min: Some(20.0),
            time: 0,
            max_flow: None,
        },
    )
    .unwrap();
    assert!(after.iter().all(|r| r.meets), "{after:?}");
}

#[test]
fn refuses_what_it_cannot_size() {
    let m = net1();
    let bad = |f: fn(&mut SizingOptions)| {
        let mut o = opts(&m);
        f(&mut o);
        size_pipes(&m, &o).unwrap_err()
    };
    assert!(bad(|o| o.pipes = vec!["9".into(), "nope".into()]).contains("not pipes: 9, nope"));
    assert!(bad(|o| o.sizes.clear()).contains("sizes"));
    assert!(bad(|o| o.sizes[1].diameter = 6.0).contains("once"));
    assert!(bad(|o| o.limits = Limits::default()).contains("limit"));
}

#[test]
fn reports_limits_it_cannot_meet() {
    let m = net1();
    let o = SizingOptions {
        limits: Limits {
            min_pressure: Some(500.0),
            ..Limits::default()
        },
        max_solutions: Some(400),
        ..opts(&m)
    };
    let r = size_pipes(&m, &o).unwrap();
    assert!(!r.meets);
    assert!(r.stopped.is_some());
    assert!(r.solutions <= 400);
}

#[test]
fn sizes_a_network_as_new() {
    let m = net1();
    let o = SizingOptions {
        limits: Limits {
            min_pressure: Some(100.0),
            max_velocity: Some(5.0),
            ..Limits::default()
        },
        from_smallest: true,
        ..opts(&m)
    };
    let r = size_pipes(&m, &o).unwrap();
    eprintln!("{r:#?}");
    assert!(r.meets, "{r:?}");
    // Costed as new: every candidate pipe, changed or not.
    let laid: f64 = m
        .links
        .iter()
        .filter_map(|l| match &l.kind {
            ws_model::LinkKind::Pipe(p) => {
                let to = r
                    .changes
                    .iter()
                    .find(|c| c.id == l.id)
                    .map_or(p.diameter, |c| c.to);
                let unit = sizes().iter().find(|s| s.diameter == to).unwrap().unit_cost;
                Some(p.length * unit)
            }
            _ => None,
        })
        .sum();
    assert!((laid - r.cost).abs() < 1e-6, "{laid} {}", r.cost);
}
