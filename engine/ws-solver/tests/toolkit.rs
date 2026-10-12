//! The toolkit API's contracts: call order, error codes and agreement with the whole-run
//! path. Agreement with OWA-EPANET's libepanet2, value for value, is checked by
//! `oracle/toolkit.sh`.

#![allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]

use ws_solver::epanet::*;

const NET: &str = "[TITLE]\n Two junctions and a tank\n\
[JUNCTIONS]\n J1 100 10 ;first\n J2 90 20\n[RESERVOIRS]\n R 200\n\
[TANKS]\n T 150 10 0 20 30 0\n\
[PIPES]\n P1 R J1 1000 12 100\n P2 J1 J2 1000 10 100\n P3 J2 T 500 10 100\n\
[PUMPS]\n\
[CURVES]\n C1 100 50\n\
[QUALITY]\n R 1.0\n\
[OPTIONS]\n Units GPM\n Quality Chlorine mg/L\n\
[REACTIONS]\n Global Bulk -0.5\n\
[COORDINATES]\n J1 1 2\n\
[TIMES]\n Duration 6:00\n Report Timestep 2:00\n Quality Timestep 0:05\n[END]\n";

fn open() -> Toolkit {
    let mut t = Toolkit::new();
    assert_eq!(t.open_text(NET), 0);
    t
}

#[test]
fn refuses_calls_out_of_order() {
    let mut t = Toolkit::new();
    let mut n = -1;
    assert_eq!(t.getcount(EN_NODECOUNT, &mut n), 102);
    assert_eq!(t.open_h(), 102);
    let mut t = open();
    let mut time = 0;
    assert_eq!(t.run_h(&mut time), 103);
    assert_eq!(t.init_h(EN_SAVE), 103);
    assert_eq!(t.open_q(), 104);
    assert_eq!(t.run_q(&mut time), 105);
    assert_eq!(t.open_text("[JUNCTIONS]\n J1 x\n[END]\n"), 200);
    assert!(!t.is_open());
}

#[test]
fn reads_the_network() {
    let t = open();
    let (mut n, mut i, mut ty) = (0, 0, 0);
    t.getcount(EN_NODECOUNT, &mut n);
    assert_eq!(n, 4);
    assert_eq!(t.getnodeindex("T", &mut i), 0);
    assert_eq!(i, 4);
    t.getnodetype(i, &mut ty);
    assert_eq!(ty, EN_TANK);
    assert_eq!(t.getnodeindex("nope", &mut i), 203);
    let mut v = 0.0;
    assert_eq!(t.getnodevalue(1, EN_ELEVATION, &mut v), 0);
    assert_eq!(v, 100.0);
    assert_eq!(t.getnodevalue(1, EN_BASEDEMAND, &mut v), 0);
    assert!((v - 10.0).abs() < 1e-12);
    assert_eq!(t.getnodevalue(1, 99, &mut v), 251);
    assert_eq!(t.getnodevalue(1, EN_SOURCEQUAL, &mut v), 240);
    let mut s = String::new();
    t.getcomment(EN_NODE, 1, &mut s);
    assert_eq!(s, "first");
    let (mut x, mut y) = (0.0, 0.0);
    assert_eq!(t.getcoord(1, &mut x, &mut y), 0);
    assert_eq!((x, y), (1.0, 2.0));
    assert_eq!(t.getcoord(2, &mut x, &mut y), 254);
    let (mut a, mut b, mut c) = (String::new(), String::new(), String::new());
    t.gettitle(&mut a, &mut b, &mut c);
    assert_eq!(a.trim(), "Two junctions and a tank");
    let mut units = 0;
    t.getflowunits(&mut units);
    assert_eq!(units, 1); // GPM
}

#[test]
fn types_curves_when_the_solver_opens() {
    let net = NET.replace("[PUMPS]\n", "[PUMPS]\n PU R J1 HEAD C1\n");
    let mut t = Toolkit::new();
    assert_eq!(t.open_text(&net), 0);
    let (mut ct, mut pt) = (0, 0);
    let mut k = 0;
    t.getlinkindex("PU", &mut k);
    t.getcurvetype(1, &mut ct);
    t.getpumptype(k, &mut pt);
    assert_eq!((ct, pt), (EN_GENERIC_CURVE, 2)); // EN_CUSTOM until validated
    assert_eq!(t.open_h(), 0);
    t.getcurvetype(1, &mut ct);
    t.getpumptype(k, &mut pt);
    assert_eq!((ct, pt), (EN_PUMP_CURVE, 1)); // a one-point curve is a power function
}

#[test]
fn stepwise_runs_agree_with_the_whole_run() {
    let model = ws_io::read_inp(NET).model;
    let whole = ws_solver::simulate(&model).unwrap();
    let mut t = open();
    assert_eq!(t.open_h(), 0);
    assert_eq!(t.init_h(EN_SAVE), 0);
    let (mut time, mut step) = (0, 0);
    let mut k = 0;
    loop {
        assert_eq!(t.run_h(&mut time), 0);
        if time % 7200 == 0 {
            for i in 1..=4 {
                let mut h = 0.0;
                t.getnodevalue(i, EN_HEAD, &mut h);
                assert_eq!(h, whole.heads[k][i as usize - 1], "t={time} node {i}");
            }
            k += 1;
        }
        t.next_h(&mut step);
        if step == 0 {
            break;
        }
    }
    assert_eq!(k, whole.heads.len());
    assert_eq!(t.close_h(), 0);
    // Quality over the saved hydraulics, stepping by quality steps.
    assert_eq!(t.open_q(), 0);
    assert_eq!(t.init_q(EN_NOSAVE), 0);
    t.run_q(&mut time);
    let mut left = 1;
    let mut steps = 0;
    while left > 0 {
        assert_eq!(t.step_q(&mut left), 0);
        steps += 1;
    }
    assert_eq!(steps, 6 * 12); // six hours of five-minute steps
    let mut c = 0.0;
    t.getnodevalue(4, EN_QUALITY, &mut c);
    let last = whole.node_quality.last().unwrap()[3];
    assert!((c - last).abs() < 0.05, "{c} vs {last}");
    let mut mb = 0.0;
    t.getstatistic(EN_MASSBALANCE, &mut mb);
    assert!((mb - 1.0).abs() < 0.01, "{mb}");
    assert_eq!(t.close_q(), 0);
    assert_eq!(t.solve_h(), 0);
    assert_eq!(t.solve_q(), 0);
    assert_eq!(t.close(), 0);
}

#[test]
fn describes_errors_as_epanet_does() {
    let mut s = String::new();
    assert_eq!(geterror(203, &mut s, 255), 0);
    assert_eq!(s, "Error 203: function call contains undefined node");
    geterror(1, &mut s, 255);
    assert_eq!(s, "WARNING: System hydraulically unbalanced.");
    geterror(203, &mut s, 10);
    assert_eq!(s, "Error 203");
    let mut v = 0;
    getversion(&mut v);
    assert_eq!(v, 20305);
}

#[test]
fn setters_change_what_the_solver_sees() {
    let mut t = open();
    let mut k = 0;
    t.getlinkindex("P2", &mut k);
    let head_at_j2 = |t: &mut Toolkit| {
        assert_eq!(t.solve_h(), 0);
        let mut h = 0.0;
        t.getnodevalue(2, EN_HEAD, &mut h);
        h
    };
    let before = head_at_j2(&mut t);
    assert_eq!(t.setlinkvalue(k, EN_DIAMETER, 16.0), 0);
    let mut d = 0.0;
    t.getlinkvalue(k, EN_DIAMETER, &mut d);
    assert_eq!(d, 16.0);
    assert!(head_at_j2(&mut t) > before, "a wider pipe loses less head");
    assert_eq!(t.setlinkvalue(k, EN_DIAMETER, -1.0), 211);
    assert_eq!(t.setnodevalue(1, EN_TANKLEVEL, 1.0), 263);
    assert_eq!(t.setnodevalue(4, EN_TANKLEVEL, 99.0), 225); // above the tank's maximum
    // A pattern, assigned to a new demand category.
    assert_eq!(t.addpattern("Peak"), 0);
    assert_eq!(t.addpattern("Peak"), 215);
    assert_eq!(t.addpattern("bad id"), 252);
    let mut p = 0;
    t.getpatternindex("Peak", &mut p);
    assert_eq!(t.setpattern(p, &[1.0, 2.0]), 0);
    assert_eq!(t.adddemand(1, 5.0, "Peak", "fire"), 0);
    let (mut n, mut idx) = (0, 0);
    t.getnumdemands(1, &mut n);
    t.getdemandindex(1, "fire", &mut idx);
    assert_eq!((n, idx), (2, 2));
    assert_eq!(t.deletedemand(1, 2), 0);
    t.getnumdemands(1, &mut n);
    assert_eq!(n, 1);
    // A timer control closing P2 at one hour.
    let mut c = 0;
    assert_eq!(t.addcontrol(2, k, 0.0, 0, 3600.0, &mut c), 0);
    assert_eq!(c, 1);
    let (mut ty, mut link, mut s, mut node, mut lvl) = (0, 0, 0.0, 0, 0.0);
    t.getcontrol(c, &mut ty, &mut link, &mut s, &mut node, &mut lvl);
    assert_eq!((ty, link, s, node, lvl), (2, k, 0.0, 0, 3600.0));
    assert_eq!(t.setcontrolenabled(c, 2), 202);
    // Options and times.
    assert_eq!(t.setoption(EN_TRIALS, 0.0), 213);
    assert_eq!(t.setoption(EN_DEMANDMULT, 1.5), 0);
    let mut v = 0.0;
    t.getoption(EN_DEMANDMULT, &mut v);
    assert_eq!(v, 1.5);
    assert_eq!(t.settimeparam(EN_HYDSTEP, 0), 213);
    // Flow units convert what the getters report.
    let mut q = 0.0;
    t.getnodevalue(1, EN_BASEDEMAND, &mut q);
    assert_eq!(t.setflowunits(5), 0); // L/s
    let mut q_si = 0.0;
    t.getnodevalue(1, EN_BASEDEMAND, &mut q_si);
    assert!(
        (q_si - q / 448.831 * 28.317).abs() < 1e-9,
        "{q} gpm is {q_si} L/s"
    );
    // Comments and IDs.
    assert_eq!(t.setcomment(EN_NODE, 1, "renamed"), 0);
    assert_eq!(t.setnodeid(1, "J1b"), 0);
    let mut id = String::new();
    t.getnodeid(1, &mut id);
    assert_eq!(id, "J1b");
    assert_eq!(t.setnodeid(2, "J1b"), 215);
}

#[test]
fn edits_the_network_structure() {
    let mut t = open();
    let (mut j, mut k, mut n, mut tank) = (0, 0, 0, 0);
    assert_eq!(t.addnode("J3", EN_JUNCTION, &mut j), 0);
    assert_eq!(j, 3); // junctions stay before tanks and reservoirs
    t.getnodeindex("T", &mut tank);
    assert_eq!(tank, 5);
    assert_eq!(t.addlink("P4", 1, "J2", "J3", &mut k), 0);
    t.getcount(EN_LINKCOUNT, &mut n);
    assert_eq!((k, n), (4, 4));
    let (mut n1, mut n2) = (0, 0);
    t.getlinknodes(3, &mut n1, &mut n2); // P3 J2-T follows the tank's new index
    assert_eq!((n1, n2), (2, 5));
    assert_eq!(t.setnodevalue(j, EN_ELEVATION, 80.0), 0);
    assert_eq!(t.setnodevalue(j, EN_BASEDEMAND, 5.0), 0);
    assert_eq!(t.solve_h(), 0);
    // Structure is locked while a solver is open.
    assert_eq!(t.open_h(), 0);
    assert_eq!(t.addnode("J4", EN_JUNCTION, &mut n), 262);
    assert_eq!(t.close_h(), 0);
    // A connected node goes only unconditionally, taking its links with it.
    assert_eq!(t.deletenode(j, 1), 259);
    assert_eq!(t.deletenode(j, 0), 0);
    t.getcount(EN_LINKCOUNT, &mut n);
    assert_eq!(n, 3);
    t.getnodeindex("T", &mut tank);
    assert_eq!(tank, 4);
    // Changing a pipe into a pump replaces it at the end.
    let mut p2 = 2;
    assert_eq!(t.setlinktype(&mut p2, 2, 0), 0);
    assert_eq!(p2, 3);
    let mut ty = 0;
    t.getlinktype(p2, &mut ty);
    assert_eq!(ty, 2);
    let mut id = String::new();
    t.getlinkid(p2, &mut id);
    assert_eq!(id, "P2");
}

#[test]
fn writes_the_same_files_as_the_whole_run() {
    let dir = std::env::temp_dir().join(format!("ws-toolkit-files-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = |name: &str| dir.join(name).to_string_lossy().into_owned();
    let (inp, rpt, out) = (path("net.inp"), path("net.rpt"), path("net.out"));
    std::fs::write(&inp, NET).unwrap();
    let date = "Mon Oct 12 12:00:00 2026";

    let mut t = Toolkit::new();
    assert_eq!(t.open_files(&inp, &rpt, &out, date), 0);
    assert_eq!(t.report(), 106);
    assert_eq!(t.save_h(), 104);
    assert_eq!(t.writeline("our own line"), 0);
    assert_eq!(t.solve_h(), 0);
    assert_eq!(t.solve_q(), 0);
    assert_eq!(t.report(), 0);
    // A report file is appended to whenever the caller flushes (ws-ffi after each call).
    assert!(matches!(t.flush_report(), ReportOutput::Nothing));
    assert_eq!(t.close(), 0);
    let report = std::fs::read_to_string(&rpt).unwrap();
    assert!(report.contains("our own line"));
    assert!(report.contains("Analysis begun"));

    let model = ws_io::read_inp(NET).model;
    let opts = ws_solver::RunOptions {
        inp_name: inp.clone(),
        date: date.to_string(),
        report: true,
        status_log: false,
    };
    let run = ws_solver::run_epanet(&model, &opts, |_| {}).unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), run.out_file());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn saves_an_input_file_that_reads_back_the_same() {
    let dir = std::env::temp_dir().join(format!("ws-toolkit-inp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let saved = dir.join("saved.inp").to_string_lossy().into_owned();
    let mut t = open();
    assert_eq!(t.setnodevalue(1, EN_ELEVATION, 105.0), 0);
    assert_eq!(
        t.addrule("RULE R1\nIF TANK T LEVEL ABOVE 15\nTHEN PIPE P3 STATUS IS CLOSED\nPRIORITY 2"),
        0
    );
    assert_eq!(t.saveinpfile(&saved), 0);
    let text = std::fs::read_to_string(&saved).unwrap();
    assert!(text.starts_with("[TITLE]\n") && text.contains("Two junctions and a tank"));
    assert!(text.contains(
        "\nRULE R1\nIF   TANK T LEVEL > 15.0000\nTHEN PIPE P3 STATUS = CLOSED\nPRIORITY 2.000000\n"
    ));
    assert!(text.ends_with("\n[END]\n"));

    let mut back = Toolkit::new();
    assert_eq!(back.open(&saved), 0);
    for tk in [&mut t, &mut back] {
        assert_eq!(tk.solve_h(), 0);
    }
    let (mut a, mut b) = (0.0, 0.0);
    for i in 1..=4 {
        t.getnodevalue(i, EN_HEAD, &mut a);
        back.getnodevalue(i, EN_HEAD, &mut b);
        assert!((a - b).abs() < 1e-3, "node {i}: {a} vs {b}");
    }
    assert_eq!(Toolkit::new().saveinpfile(&saved), 102);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn saves_and_uses_hydraulics_files() {
    let dir = std::env::temp_dir().join(format!("ws-toolkit-hyd-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let hyd = dir.join("net.hyd").to_string_lossy().into_owned();
    let mut t = open();
    assert_eq!(t.savehydfile(&hyd), 104);
    assert_eq!(t.solve_h(), 0);
    assert_eq!(t.savehydfile(&hyd), 0);
    assert_eq!(t.solve_q(), 0);
    let mut expect = 0.0;
    t.getnodevalue(2, EN_QUALITY, &mut expect);

    let mut u = open();
    assert_eq!(
        u.usehydfile(&dir.join("missing.hyd").to_string_lossy()),
        305
    );
    assert_eq!(u.usehydfile(&hyd), 0);
    assert_eq!(u.solve_q(), 0);
    let mut got = 0.0;
    u.getnodevalue(2, EN_QUALITY, &mut got);
    assert_eq!(got.to_bits(), expect.to_bits());
    // The solver stays shut while a file is in use, and trying forgets the file.
    assert_eq!(u.open_h(), 107);
    assert_eq!(u.open_q(), 104);

    // A file saved for another network is refused.
    let mut other = Toolkit::new();
    assert_eq!(
        other.open_text(&NET.replace("Duration 6:00", "Duration 7:00")),
        0
    );
    assert_eq!(other.usehydfile(&hyd), 306);
    std::fs::remove_dir_all(&dir).unwrap();
}
