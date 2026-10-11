//! EPANET-MSX runs on the repository's fixtures. Bit-for-bit agreement with the
//! reference engine is checked by `oracle/msx.sh`; these tests pin behavior that does
//! not need the reference: completion, mass balances, reports and input errors.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ws_msx::Msx;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/../../oracle/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn network() -> ws_model::Model {
    ws_io::read_inp(&fixture("quality-chem.inp")).model
}

fn run(msx: &str) -> Msx {
    let mut m = Msx::from_model(&network(), msx, "test.msx").unwrap();
    m.solve().unwrap();
    m
}

/// FNV-1a, to pin a results file without storing it.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(0x100_0000_01b3)
    })
}

#[test]
fn every_source_type_and_tank_model_runs_to_the_end() {
    let m = run(&fixture("msx/tanks-sources.msx"));
    let species: Vec<String> = m.species().into_iter().map(|s| s.id).collect();
    assert_eq!(species, ["CL2", "TOC", "TR", "BIO", "AGE", "HYD", "SUM"]);
    assert_eq!(m.periods(), 25, "48 h reported every 2 h, with time 0");
    let report = m.report().unwrap();
    assert!(
        report.contains("<<< Node TA >>>") && report.contains("<<< Link PU >>>"),
        "{report}"
    );
    assert!(report.contains("Water Quality Mass Balance: CL2 (MG)"));
    // A formula species equals its formula at every node.
    let (cl2, toc, tr, sum) = (1, 2, 3, 7);
    for n in 1..=11 {
        let expect = m.node_quality(n, cl2) + m.node_quality(n, toc) + m.node_quality(n, tr);
        assert!(
            (m.node_quality(n, sum) - expect).abs() < 1e-9 * expect.max(1.0),
            "node {n}"
        );
    }
    // Wall species are not reported at nodes.
    assert_eq!(m.node_quality(1, 4), 0.0);
}

/// FNV-1a of the results file EPANET-MSX writes for this case.
const PINNED: u64 = 0x1879_db85_b4ce_cc78;

#[test]
fn results_are_pinned() {
    // These bytes match EPANET-MSX 2.0 (oracle/msx.sh); a change here changes results.
    let m = run(&fixture("msx/decay-euler.msx"));
    let out = m.output_file().unwrap();
    assert_eq!(&out[..4], &516114521i32.to_le_bytes());
    assert_eq!(fnv(out), PINNED);
}

#[test]
fn first_order_decay_balances_mass() {
    let m = run(&fixture("msx/decay-euler.msx"));
    let report = m.report().unwrap();
    let ratio: f64 = report
        .lines()
        .find(|l| l.contains("Mass Ratio:"))
        .and_then(|l| l.split_whitespace().last())
        .unwrap()
        .parse()
        .unwrap();
    // EPANET-MSX's accounting with Euler steps and tanks is approximate (0.93 here,
    // exactly as the reference reports it).
    assert!((ratio - 1.0).abs() < 0.1, "mass ratio {ratio}");
}

#[test]
fn equilibrium_and_dispersion_run() {
    let m = run(&fixture("msx/equil-ros2.msx"));
    // OH * H = Kw at equilibrium, at a junction.
    let (h, oh) = (
        m.species_index("H").unwrap(),
        m.species_index("OH").unwrap(),
    );
    let prod = m.node_quality(1, h) * m.node_quality(1, oh);
    assert!((prod - 1.0e-8).abs() < 1.0e-10, "{prod}");
    let m = run(&fixture("msx/dispersion.msx"));
    assert!(m.report().unwrap().contains("<<< Link 5 >>>"));
}

fn open_err(msx: &str) -> ws_msx::MsxError {
    Msx::from_model(&network(), msx, "bad.msx").unwrap_err()
}

#[test]
fn input_errors_are_reported_with_their_line() {
    let e = open_err("[SPECIES]\nBULK A MG\n[PIPES]\nRATE A -k*A\n");
    assert_eq!(e.code, 506);
    assert!(e.messages.iter().any(|m| m.contains("Error 409 (illegal math expression) at line 4 of [PIPE] section:")), "{e:?}");

    let e = open_err("[SPECIES]\nBULK A MG\nBULK A MG\n");
    assert!(e.messages.iter().any(|m| m.contains("Error 407")), "{e:?}");

    let e = open_err("[SPECIES]\nBULK D MG\n");
    assert!(
        e.messages.iter().any(|m| m.contains("Error 406")),
        "reserved name: {e:?}"
    );

    let e = open_err("[SPECIES]\nBULK A MG\n[PIPES]\nRATE A -A\n[QUALITY]\nNODE nowhere A 1\n");
    assert!(e.messages.iter().any(|m| m.contains("Error 405")), "{e:?}");

    let e = open_err("[SPECIES]\nBULK A MG\n[TERMS]\nT1 T2\nT2 T1\n[PIPES]\nRATE A -T1\n");
    assert!(
        e.messages
            .iter()
            .any(|m| m.contains("term T1 contains a cyclic reference")),
        "{e:?}"
    );
}

#[test]
fn missing_expressions_are_errors() {
    assert_eq!(
        open_err("[SPECIES]\nBULK A MG\nBULK B MG\n[PIPES]\nRATE A -A\n").code,
        507
    );
    // With a wall species, tanks need their own chemistry.
    assert_eq!(
        open_err("[SPECIES]\nBULK A MG\nWALL W UG\n[PIPES]\nRATE A -A\nRATE W 0\n").code,
        508
    );
}
