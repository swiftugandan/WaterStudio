// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (inpfile.c), Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! `EN_saveinpfile`: the project, as the toolkit has it now, written as an input file
//! (`inpfile.c`).

use super::{Open, Toolkit};
use crate::cfmt::{f as cf, l, r};
use crate::quality::{DIFFUS, MixModel, SourceType};
use crate::report::{HI, LOW, Statflag, Tstat, clocktime};
use crate::types::*;

/// `MAXLINE`: `fgets` reads at most this many bytes less one per call.
const MAXLINE: usize = 1024;

/// The section keywords, in `SectTxt` order.
const SECT_TXT: [&str; 30] = [
    "[TITLE]",
    "[JUNCTIONS]",
    "[RESERVOIRS]",
    "[TANKS]",
    "[PIPES]",
    "[PUMPS]",
    "[VALVES]",
    "[CONTROLS]",
    "[RULES]",
    "[DEMANDS]",
    "[SOURCES]",
    "[EMITTERS]",
    "[PATTERNS]",
    "[CURVES]",
    "[QUALITY]",
    "[STATUS]",
    "[ROUGHNESS]",
    "[ENERGY]",
    "[REACTIONS]",
    "[MIXING]",
    "[REPORT]",
    "[TIMES]",
    "[OPTIONS]",
    "[COORDINATES]",
    "[VERTICES]",
    "[LABELS]",
    "[BACKDROP]",
    "[TAGS]",
    "[LEAKAGE]",
    "[END]",
];
const S_LABELS: usize = 25;
const S_BACKDROP: usize = 26;
const S_END: usize = 29;

const STAT_TXT: [&str; 11] = [
    "closed because cannot deliver head",
    "temporarily closed",
    "closed",
    "open",
    "active",
    "open but exceeds maximum flow",
    "open but cannot deliver flow",
    "open but cannot deliver pressure",
    "filling",
    "emptying",
    "overflowing",
];
const LINK_TXT: [&str; 10] = [
    "CV", "Pipe", "Pump", "PRV", "PSV", "PBV", "FCV", "TCV", "GPV", "PCV",
];
const FLOW_UNITS_TXT: [&str; 11] = [
    "CFS", "GPM", "MGD", "IMGD", "AFD", "LPS", "LPM", "MLD", "CMH", "CMD", "CMS",
];
const PRESS_UNITS_TXT: [&str; 5] = ["PSI", "KPA", "METERS", "BAR", "FEET"];
const CURVE_TYPE_TXT: [&str; 6] = ["VOLUME", "PUMP", "EFFIC", "HEADLOSS", "GENERIC", "VALVE"];
const RPT_FLAG_TXT: [&str; 3] = ["NO", "YES", "FULL"];

/// `%-{w}.{p}f`
fn fl(v: f64, w: usize, p: usize) -> String {
    l(&cf(v, p), w)
}

/// `%{w}.{p}f`
fn fr(v: f64, w: usize, p: usize) -> String {
    r(&cf(v, p), w)
}

/// `SQR`
fn sqr(x: f64) -> f64 {
    x * x
}

impl Toolkit {
    /// `EN_saveinpfile`
    pub fn saveinpfile(&self, filename: &str) -> i32 {
        let Some(o) = self.o() else { return 102 };
        let text = saveinpfile(o);
        if std::fs::write(filename, text).is_err() {
            return 302;
        }
        0
    }
}

/// `saveinpfile`: the input file's text.
fn saveinpfile(o: &Open) -> String {
    let pr = &o.pr;
    let net = &pr.net;
    let hyd = &pr.hyd;
    let qual = &pr.qual;
    let rpt = &pr.rpt;
    let times = &pr.times;
    let meta = &o.meta;
    let ucf = |fld: Field| pr.units.ucf[fld as usize];
    let comment = |c: &Option<String>| c.as_ref().map(|c| format!("\t;{c}")).unwrap_or_default();
    let mut f = String::new();

    // [TITLE]
    f.push_str("[TITLE]");
    for t in &meta.title {
        if !t.is_empty() {
            f.push_str(&format!("\n{t}"));
        }
    }

    // [JUNCTIONS] (demands go in [DEMANDS])
    f.push_str("\n\n[JUNCTIONS]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}\t{}",
        l("ID", 31),
        l("Elev", 12),
        l("Demand", 12),
        l("Pattern", 31)
    ));
    for i in 1..=net.njuncs {
        let node = &net.node[i];
        f.push_str(&format!(
            "\n {}\t{}",
            l(&node.id, 31),
            fl(node.el * ucf(Field::Elev), 12, 4)
        ));
        f.push_str(&comment(&meta.node_comment[i]));
    }

    // [RESERVOIRS]
    f.push_str("\n\n[RESERVOIRS]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}",
        l("ID", 31),
        l("Head", 12),
        l("Pattern", 31)
    ));
    for i in 1..=net.ntanks {
        let tank = &net.tank[i];
        if tank.a == 0.0 {
            let node = &net.node[tank.node];
            let s = format!(
                " {}\t{}",
                l(&node.id, 31),
                fl(node.el * ucf(Field::Elev), 12, 4)
            );
            let s1 = if tank.pat > 0 {
                net.pattern[tank.pat].id.as_str()
            } else {
                " "
            };
            f.push_str(&format!("\n{s}\t{}", l(s1, 31)));
            f.push_str(&comment(&meta.node_comment[tank.node]));
        }
    }

    // [TANKS]
    f.push_str("\n\n[TANKS]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        l("ID", 31),
        l("Elevation", 12),
        l("InitLevel", 12),
        l("MinLevel", 12),
        l("MaxLevel", 12),
        l("Diameter", 12),
        l("MinVol", 12),
        l("VolCurve", 31),
        l("Overflow", 12)
    ));
    for i in 1..=net.ntanks {
        let tank = &net.tank[i];
        if tank.a > 0.0 {
            let node = &net.node[tank.node];
            let u = ucf(Field::Elev);
            let s = format!(
                " {}\t{}\t{}\t{}\t{}\t{}\t{}",
                l(&node.id, 31),
                fl(node.el * u, 12, 4),
                fl((tank.h0 - node.el) * u, 12, 4),
                fl((tank.hmin - node.el) * u, 12, 4),
                fl((tank.hmax - node.el) * u, 12, 4),
                fl((4.0 * tank.a / PI).sqrt() * u, 12, 4),
                fl(tank.vmin * sqr(u) * u, 12, 4)
            );
            let s1 = if tank.vcurve > 0 {
                net.curve[tank.vcurve].id.as_str()
            } else if tank.can_overflow {
                "*"
            } else {
                " "
            };
            f.push_str(&format!("\n{s}\t{}", l(s1, 31)));
            if tank.can_overflow {
                f.push_str(&format!("\t{}", l("YES", 12)));
            }
            f.push_str(&comment(&meta.node_comment[tank.node]));
        }
    }

    // [PIPES]
    f.push_str("\n\n[PIPES]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
        l("ID", 31),
        l("Node1", 31),
        l("Node2", 31),
        l("Length", 12),
        l("Diameter", 12),
        l("Roughness", 12),
        l("MinorLoss", 12),
        l("Status", 6)
    ));
    for i in 1..=net.nlinks {
        let link = &net.link[i];
        if link.link_type <= LinkType::Pipe {
            let d = link.diam;
            let mut kc = link.init_setting;
            if hyd.formflag == Formula::Dw {
                kc = kc * ucf(Field::Elev) * 1000.0;
            }
            let km = link.km * sqr(d) * sqr(d) / 0.02517;
            let s = format!(
                " {}\t{}\t{}\t{}\t{}\t{}\t{}",
                l(&link.id, 31),
                l(&net.node[link.n1].id, 31),
                l(&net.node[link.n2].id, 31),
                fl(link.len * ucf(Field::Length), 12, 4),
                fl(d * ucf(Field::Diam), 12, 4),
                fl(kc, 12, 4),
                fl(km, 12, 4)
            );
            let s2 = if link.link_type == LinkType::CvPipe {
                "CV"
            } else if link.init_status == Status::Closed {
                "CLOSED"
            } else {
                " "
            };
            f.push_str(&format!("\n{s}\t{}", l(s2, 6)));
            f.push_str(&comment(&meta.link_comment[i]));
        }
    }

    // [PUMPS]
    f.push_str("\n\n[PUMPS]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}\t{}",
        l("ID", 31),
        l("Node1", 31),
        l("Node2", 31),
        l("Parameters", 12)
    ));
    for i in 1..=net.npumps {
        let pump = &net.pump[i];
        let n = pump.link;
        let link = &net.link[n];
        let mut s = format!(
            " {}\t{}\t{}",
            l(&link.id, 31),
            l(&net.node[link.n1].id, 31),
            l(&net.node[link.n2].id, 31)
        );
        if pump.ptype == PumpType::ConstHp {
            s.push_str(&format!("\tPOWER {}", cf(link.km, 4)));
        } else if pump.hcurve > 0 {
            s.push_str(&format!("\tHEAD {}", net.curve[pump.hcurve].id));
        } else {
            // The old format for a pump curve.
            f.push_str(&format!(
                "\n{s} {} {} {}          0.0 {}",
                fr(-pump.h0 * ucf(Field::Head), 12, 4),
                fr(
                    (-pump.h0 - pump.r * pow(pump.q0, pump.n)) * ucf(Field::Head),
                    12,
                    4
                ),
                fr(pump.q0 * ucf(Field::Flow), 12, 4),
                fr(pump.qmax * ucf(Field::Flow), 12, 4)
            ));
            continue;
        }
        if pump.upat > 0 {
            s.push_str(&format!("\tPATTERN {}", net.pattern[pump.upat].id));
        }
        if link.init_setting != 1.0 {
            s.push_str(&format!("\tSPEED {}", cf(link.init_setting, 4)));
        }
        f.push_str(&format!("\n{s}"));
        f.push_str(&comment(&meta.link_comment[n]));
    }

    // [VALVES]
    f.push_str("\n\n[VALVES]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}\t{}\t{}\t{}\t{}",
        l("ID", 31),
        l("Node1", 31),
        l("Node2", 31),
        l("Diameter", 12),
        l("Type", 6),
        l("Setting", 12),
        l("MinorLoss", 12)
    ));
    for i in 1..=net.nvalves {
        let n = net.valve[i].link;
        let link = &net.link[n];
        let d = link.diam;
        let mut kc = link.init_setting;
        match link.link_type {
            LinkType::Fcv => kc *= ucf(Field::Flow),
            LinkType::Prv | LinkType::Psv | LinkType::Pbv => kc *= ucf(Field::Pressure),
            _ => {}
        }
        let km = link.km * sqr(d) * sqr(d) / 0.02517;
        let s = format!(
            " {}\t{}\t{}\t{}\t{}",
            l(&link.id, 31),
            l(&net.node[link.n1].id, 31),
            l(&net.node[link.n2].id, 31),
            fl(d * ucf(Field::Diam), 12, 4),
            l(LINK_TXT[link.link_type as usize], 6)
        );
        let j = round(kc);
        let s1 = if link.link_type == LinkType::Gpv && j > 0 {
            format!("{}\t{}", l(&net.curve[j as usize].id, 31), fl(km, 12, 4))
        } else if link.link_type == LinkType::Pcv && net.valve[i].curve > 0 {
            format!(
                "{}\t{}\t{}",
                fl(kc, 12, 4),
                fl(km, 12, 4),
                l(&net.curve[net.valve[i].curve].id, 31)
            )
        } else {
            format!("{}\t{}", fl(kc, 12, 4), fl(km, 12, 4))
        };
        f.push_str(&format!("\n{s}\t{s1}"));
        f.push_str(&comment(&meta.link_comment[n]));
    }

    // [DEMANDS]
    f.push_str("\n\n[DEMANDS]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}\t{}",
        l("Junction", 31),
        l("Demand", 14),
        l("Pattern", 31),
        l("Category", 31)
    ));
    let dcf = ucf(Field::Demand);
    for i in 1..=net.njuncs {
        let node = &net.node[i];
        for (k, demand) in node.d.iter().enumerate() {
            if demand.base == 0.0 {
                continue;
            }
            let s = format!(" {}\t{}", l(&node.id, 31), fl(dcf * demand.base, 14, 6));
            let s1 = if demand.pat > 0 {
                l(&net.pattern[demand.pat].id, 31)
            } else {
                " ".to_string()
            };
            f.push_str(&format!("\n{s}\t{}", l(&s1, 31)));
            if let Some(Some(name)) = meta.demand_name.get(i).and_then(|d| d.get(k)) {
                f.push_str(&format!("\t;{name}"));
            }
        }
    }

    // [EMITTERS]
    f.push_str("\n\n[EMITTERS]");
    f.push_str(&format!(
        "\n;;{}\t{}",
        l("Junction", 31),
        l("Coefficient", 14)
    ));
    for i in 1..=net.njuncs {
        let node = &net.node[i];
        if node.ke == 0.0 {
            continue;
        }
        let ke = ucf(Field::Flow) / pow(ucf(Field::Pressure) * node.ke, 1.0 / hyd.qexp);
        f.push_str(&format!("\n {}\t{}", l(&node.id, 31), fl(ke, 14, 6)));
    }

    // [LEAKAGE]
    f.push_str("\n\n[LEAKAGE]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}",
        l("Pipe", 31),
        l("Leak Area", 14),
        l("Leak Expansion", 14)
    ));
    for i in 1..=net.nlinks {
        let link = &net.link[i];
        if link.leak_area == 0.0 && link.leak_expan == 0.0 {
            continue;
        }
        f.push_str(&format!(
            "\n {} {} {}",
            l(&link.id, 31),
            fr(link.leak_area / ucf(Field::Length), 14, 6),
            fr(link.leak_expan / ucf(Field::Length), 14, 6)
        ));
    }

    // [STATUS]
    f.push_str("\n\n[STATUS]");
    f.push_str(&format!("\n;;{}\t{}", l("ID", 31), l("Status/Setting", 12)));
    for i in 1..=net.nlinks {
        let link = &net.link[i];
        if link.link_type <= LinkType::Pump {
            if link.init_status == Status::Closed {
                f.push_str(&format!(
                    "\n {}\t{}",
                    l(&link.id, 31),
                    STAT_TXT[Status::Closed as usize]
                ));
            } else if link.link_type == LinkType::Pump {
                // The speed of a pump given by the old pump curve format.
                let pump = &net.pump[net.findpump(i)];
                if pump.hcurve == 0 && pump.ptype != PumpType::ConstHp && link.init_setting != 1.0 {
                    f.push_str(&format!(
                        "\n {}\t{}",
                        l(&link.id, 31),
                        cf(link.init_setting, 4)
                    ));
                }
            }
        } else {
            // Valves with a fixed status.
            if link.init_status == Status::Open {
                f.push_str(&format!(
                    "\n {}\t{}",
                    l(&link.id, 31),
                    STAT_TXT[Status::Open as usize]
                ));
            }
            if link.init_status == Status::Closed {
                f.push_str(&format!(
                    "\n{}\t{}",
                    l(&link.id, 31),
                    STAT_TXT[Status::Closed as usize]
                ));
            }
        }
    }

    // [PATTERNS], six factors a line
    f.push_str("\n\n[PATTERNS]");
    f.push_str(&format!("\n;;{}\t{}", l("ID", 31), l("Multipliers", 12)));
    for i in 1..net.pattern.len() {
        let pat = &net.pattern[i];
        if let Some(c) = &meta.pattern_comment[i] {
            f.push_str(&format!("\n;{c}"));
        }
        for (j, v) in pat.f.iter().enumerate() {
            if j % 6 == 0 {
                f.push_str(&format!("\n {}", l(&pat.id, 31)));
            }
            f.push_str(&format!("\t{}", fl(*v, 12, 4)));
        }
    }

    // [CURVES]
    f.push_str("\n\n[CURVES]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}",
        l("ID", 31),
        l("X-Value", 12),
        l("Y-Value", 12)
    ));
    for i in 1..net.curve.len() {
        let curve = &net.curve[i];
        if let Some(c) = &meta.curve_comment[i] {
            f.push_str(&format!("\n;{c}"));
        }
        if !curve.x.is_empty() {
            let ty = usize::try_from(o.curve_type[i])
                .ok()
                .and_then(|t| CURVE_TYPE_TXT.get(t));
            f.push_str(&format!(
                "\n {}\t{}\t{}\t{}",
                l(&curve.id, 31),
                fl(curve.x[0], 12, 4),
                fl(curve.y[0], 12, 4),
                ty.copied().unwrap_or("")
            ));
            for j in 1..curve.x.len() {
                f.push_str(&format!(
                    "\n {}\t{}\t{}",
                    l(&curve.id, 31),
                    fl(curve.x[j], 12, 4),
                    fl(curve.y[j], 12, 4)
                ));
            }
        }
    }

    // [CONTROLS]
    f.push_str("\n\n[CONTROLS]");
    for i in 1..=net.ncontrols {
        let control = &net.control[i];
        let j = control.link;
        if j == 0 {
            continue;
        }
        let link = &net.link[j];
        let status_txt = STAT_TXT[control.status as usize];
        let s = if control.setting == MISSING
            || link.link_type == LinkType::Gpv
            || link.link_type == LinkType::Pipe
            || (link.link_type == LinkType::Pump
                && (control.setting == 0.0 || control.setting == 1.0))
        {
            format!(" LINK {} {status_txt} ", link.id)
        } else {
            let mut kc = control.setting;
            match link.link_type {
                LinkType::Prv | LinkType::Psv | LinkType::Pbv => kc *= ucf(Field::Pressure),
                LinkType::Fcv => kc *= ucf(Field::Flow),
                _ => {}
            }
            format!(" LINK {} {}", link.id, cf(kc, 4))
        };
        match control.control_type {
            ControlType::LowLevel | ControlType::HiLevel => {
                let n = control.node;
                let node = &net.node[n];
                let mut kc = control.grade - node.el;
                if n > net.njuncs {
                    kc *= ucf(Field::Head);
                } else {
                    kc *= ucf(Field::Pressure);
                }
                let word = if control.control_type == ControlType::LowLevel {
                    "BELOW"
                } else {
                    "ABOVE"
                };
                f.push_str(&format!("\n{s} IF NODE {} {word} {}", node.id, cf(kc, 4)));
            }
            ControlType::Timer => {
                f.push_str(&format!(
                    "\n{s} AT TIME {} HOURS",
                    cf(control.time as f64 / 3600.0, 4)
                ));
            }
            ControlType::TimeOfDay => {
                f.push_str(&format!("\n{s} AT CLOCKTIME {}", clocktime(control.time)));
            }
        }
        if !control.is_enabled {
            f.push_str("  DISABLED");
        }
    }

    // [RULES]
    f.push_str("\n\n[RULES]");
    for (i, rule) in pr.rules.iter().enumerate() {
        f.push_str(&format!("\nRULE {}", rule.label));
        crate::rules::writerule(pr, &mut f, i);
        if !rule.is_enabled {
            f.push_str("\nDISABLED");
        }
        f.push('\n');
    }

    // [QUALITY] (nodes of zero initial quality left out)
    f.push_str("\n\n[QUALITY]");
    f.push_str(&format!("\n;;{}\t{}", l("ID", 31), l("InitQual", 14)));
    for i in 1..=net.nnodes {
        let node = &net.node[i];
        if node.c0 == 0.0 {
            continue;
        }
        f.push_str(&format!(
            "\n {}\t{}",
            l(&node.id, 31),
            fl(node.c0 * ucf(Field::Quality), 14, 6)
        ));
    }

    // [SOURCES]
    f.push_str("\n\n[SOURCES]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}\t{}",
        l("ID", 31),
        l("Type", 9),
        l("Quality", 14),
        l("Pattern", 31)
    ));
    for i in 1..=net.nnodes {
        let node = &net.node[i];
        let Some(source) = &node.source else { continue };
        let kind = match source.kind {
            SourceType::Concen => "CONCEN",
            SourceType::Mass => "MASS",
            SourceType::Setpoint => "SETPOINT",
            SourceType::FlowPaced => "FLOWPACED",
        };
        let s = format!(
            " {}\t{}\t{}",
            l(&node.id, 31),
            l(kind, 9),
            fl(source.c0, 14, 6)
        );
        let s1 = if source.pat > 0 {
            net.pattern[source.pat].id.as_str()
        } else {
            ""
        };
        f.push_str(&format!("\n{s}\t{s1}"));
    }

    // [MIXING]
    f.push_str("\n\n[MIXING]");
    f.push_str(&format!("\n;;{}\t{}", l("ID", 31), l("Model", 8)));
    for i in 1..=net.ntanks {
        let tank = &net.tank[i];
        if tank.a == 0.0 {
            continue;
        }
        let model = match tank.mix_model {
            MixModel::Mix1 => "MIXED",
            MixModel::Mix2 => "2COMP",
            MixModel::Fifo => "FIFO",
            MixModel::Lifo => "LIFO",
        };
        f.push_str(&format!(
            "\n {}\t{}\t{}",
            l(&net.node[tank.node].id, 31),
            l(model, 8),
            fr(tank.v1frac, 12, 4)
        ));
    }

    // [REACTIONS]: the global parameters
    let spd = SECPERDAY as f64;
    f.push_str("\n\n[REACTIONS]");
    f.push_str(&format!(
        "\n ORDER  BULK            {}",
        cf(qual.bulk_order, 2)
    ));
    f.push_str(&format!(
        "\n ORDER  WALL            {}",
        cf(qual.wall_order, 0)
    ));
    f.push_str(&format!(
        "\n ORDER  TANK            {}",
        cf(qual.tank_order, 2)
    ));
    f.push_str(&format!(
        "\n GLOBAL BULK            {}",
        cf(qual.kbulk * spd, 6)
    ));
    f.push_str(&format!(
        "\n GLOBAL WALL            {}",
        cf(qual.kwall * spd, 6)
    ));
    if qual.climit > 0.0 {
        f.push_str(&format!(
            "\n LIMITING POTENTIAL     {}",
            cf(qual.climit * ucf(Field::Quality), 6)
        ));
    }
    if qual.rfactor != MISSING && qual.rfactor != 0.0 {
        f.push_str(&format!(
            "\n ROUGHNESS CORRELATION  {}",
            cf(qual.rfactor, 6)
        ));
    }

    // ...and those of each pipe and tank
    f.push_str("\n\n[REACTIONS]");
    f.push_str(&format!(
        "\n;{}\t{}\t{}",
        l("Type", 9),
        l("Pipe/Tank", 31),
        l("Coefficient", 12)
    ));
    for i in 1..=net.nlinks {
        let link = &net.link[i];
        if link.link_type > LinkType::Pipe {
            continue;
        }
        if link.kb != qual.kbulk {
            f.push_str(&format!(
                "\n {}\t{}\t{}",
                l("BULK", 9),
                l(&link.id, 31),
                cf(link.kb * spd, 6)
            ));
        }
        if link.kw != qual.kwall {
            f.push_str(&format!(
                "\n {}\t{}\t{}",
                l("WALL", 9),
                l(&link.id, 31),
                cf(link.kw * spd, 6)
            ));
        }
    }
    for i in 1..=net.ntanks {
        let tank = &net.tank[i];
        if tank.a == 0.0 {
            continue;
        }
        if tank.kb != qual.kbulk {
            f.push_str(&format!(
                "\n {}\t{}\t{}",
                l("TANK", 9),
                l(&net.node[tank.node].id, 31),
                cf(tank.kb * spd, 6)
            ));
        }
    }

    // [ENERGY]
    f.push_str("\n\n[ENERGY]");
    if hyd.ecost != 0.0 {
        f.push_str(&format!("\n GLOBAL PRICE        {}", cf(hyd.ecost, 4)));
    }
    if hyd.epat != 0 {
        f.push_str(&format!(
            "\n GLOBAL PATTERN      {}",
            net.pattern[hyd.epat].id
        ));
    }
    f.push_str(&format!("\n GLOBAL EFFIC        {}", cf(hyd.epump, 4)));
    f.push_str(&format!("\n DEMAND CHARGE       {}", cf(hyd.dcost, 4)));
    for i in 1..=net.npumps {
        let pump = &net.pump[i];
        let id = l(&net.link[pump.link].id, 31);
        if pump.ecost > 0.0 {
            f.push_str(&format!("\n PUMP {id} PRICE   {}", cf(pump.ecost, 4)));
        }
        if pump.epat > 0 {
            f.push_str(&format!(
                "\n PUMP {id} PATTERN {}",
                net.pattern[pump.epat].id
            ));
        }
        if pump.ecurve > 0 {
            f.push_str(&format!(
                "\n PUMP {id} EFFIC   {}",
                net.curve[pump.ecurve].id
            ));
        }
    }

    // [TIMES]
    f.push_str("\n\n[TIMES]");
    for (name, t) in [
        ("DURATION           ", times.dur),
        ("HYDRAULIC TIMESTEP ", times.hstep),
        ("QUALITY TIMESTEP   ", times.qstep),
        ("REPORT TIMESTEP    ", times.rstep),
        ("REPORT START       ", times.rstart),
        ("PATTERN TIMESTEP   ", times.pstep),
        ("PATTERN START      ", times.pstart),
        ("RULE TIMESTEP      ", times.rulestep),
        ("START CLOCKTIME    ", times.tstart),
    ] {
        f.push_str(&format!("\n {name} {}", clocktime(t)));
    }
    let tstat = match rpt.tstatflag {
        Tstat::Series => "NONE",
        Tstat::Avg => "AVERAGE",
        Tstat::Min => "MINIMUM",
        Tstat::Max => "MAXIMUM",
        Tstat::Range => "RANGE",
    };
    f.push_str(&format!("\n STATISTIC           {tstat}"));

    // [OPTIONS]
    f.push_str("\n\n[OPTIONS]");
    f.push_str(&format!(
        "\n UNITS               {}",
        FLOW_UNITS_TXT[pr.units.flowflag as usize]
    ));
    let press = PRESS_UNITS_TXT
        .get(pr.units.pressflag as usize)
        .copied()
        .unwrap_or("");
    f.push_str(&format!("\n PRESSURE            {press}"));
    let form = match hyd.formflag {
        Formula::Hw => "H-W",
        Formula::Dw => "D-W",
        Formula::Cm => "C-M",
    };
    f.push_str(&format!("\n HEADLOSS            {form}"));
    // A file written by a hydraulic run in progress is never named here: the toolkit
    // keeps its hydraulics in memory (EPANET's scratch file).
    if o.hyd_use {
        f.push_str(&format!("\n HYDRAULICS USE      {}", o.hyd_fname));
    }
    if hyd.extra_iter == -1 {
        f.push_str("\n UNBALANCED          STOP");
    }
    if hyd.extra_iter >= 0 {
        f.push_str(&format!(
            "\n UNBALANCED          CONTINUE {}",
            hyd.extra_iter
        ));
    }
    match qual.qualflag {
        QualType::Chem => {
            f.push_str(&format!(
                "\n QUALITY             {} {}",
                qual.chem_name, qual.chem_units
            ));
        }
        QualType::Trace => {
            f.push_str(&format!(
                "\n QUALITY             TRACE {}",
                l(&net.node[qual.trace_node].id, 31)
            ));
        }
        QualType::Age => f.push_str("\n QUALITY             AGE"),
        QualType::None => f.push_str("\n QUALITY             NONE"),
    }
    if hyd.def_pat > 0 {
        f.push_str(&format!(
            "\n PATTERN             {}",
            net.pattern[hyd.def_pat].id
        ));
    }
    f.push_str(&format!("\n DEMAND MULTIPLIER   {}", cf(hyd.dmult, 4)));
    f.push_str(&format!("\n EMITTER EXPONENT    {}", cf(1.0 / hyd.qexp, 4)));
    let backflow = if hyd.emit_back_flag { "YES" } else { "NO" };
    f.push_str(&format!("\n BACKFLOW ALLOWED    {backflow}"));
    f.push_str(&format!(
        "\n VISCOSITY           {}",
        cf(hyd.viscos / VISCOS, 6)
    ));
    f.push_str(&format!(
        "\n DIFFUSIVITY         {}",
        cf(qual.diffus / DIFFUS, 6)
    ));
    f.push_str(&format!("\n SPECIFIC GRAVITY    {}", cf(hyd.sp_grav, 6)));
    f.push_str(&format!("\n TRIALS              {}", hyd.max_iter));
    f.push_str(&format!("\n ACCURACY            {}", cf(hyd.hacc, 8)));
    f.push_str(&format!(
        "\n TOLERANCE           {}",
        cf(qual.ctol * ucf(Field::Quality), 8)
    ));
    f.push_str(&format!("\n CHECKFREQ           {}", hyd.check_freq));
    f.push_str(&format!("\n MAXCHECK            {}", hyd.max_check));
    f.push_str(&format!("\n DAMPLIMIT           {}", cf(hyd.damp_limit, 8)));
    if hyd.head_error_limit > 0.0 {
        f.push_str(&format!(
            "\n HEADERROR           {}",
            cf(hyd.head_error_limit * ucf(Field::Head), 8)
        ));
    }
    if hyd.flow_change_limit > 0.0 {
        f.push_str(&format!(
            "\n FLOWCHANGE          {}",
            cf(hyd.flow_change_limit * ucf(Field::Flow), 8)
        ));
    }
    if hyd.demand_model == DemandModel::Pda {
        f.push_str("\n DEMAND MODEL        PDA");
        f.push_str(&format!(
            "\n MINIMUM PRESSURE    {}",
            cf(hyd.pmin * ucf(Field::Pressure), 4)
        ));
        f.push_str(&format!(
            "\n REQUIRED PRESSURE   {}",
            cf(hyd.preq * ucf(Field::Pressure), 4)
        ));
        f.push_str(&format!("\n PRESSURE EXPONENT   {}", cf(hyd.pexp, 4)));
    }

    // [REPORT]
    f.push_str("\n\n[REPORT]");
    let yes = |b: bool| RPT_FLAG_TXT[usize::from(b)];
    f.push_str(&format!("\n PAGESIZE            {}", rpt.page_size));
    let stat = match rpt.statflag {
        Statflag::No => 0,
        Statflag::Yes => 1,
        Statflag::Full => 2,
    };
    f.push_str(&format!("\n STATUS              {}", RPT_FLAG_TXT[stat]));
    f.push_str(&format!("\n SUMMARY             {}", yes(rpt.summaryflag)));
    f.push_str(&format!("\n ENERGY              {}", yes(rpt.energyflag)));
    f.push_str(&format!("\n MESSAGES            {}", yes(rpt.messageflag)));
    if !rpt.rpt2_fname.is_empty() {
        f.push_str(&format!("\n FILE                {}", rpt.rpt2_fname));
    }
    let node_ids: Vec<&str> = net.node.iter().map(|n| n.id.as_str()).collect();
    let link_ids: Vec<&str> = net.link.iter().map(|k| k.id.as_str()).collect();
    for (flag, word, n, listed, ids) in [
        (rpt.nodeflag, "NODES", net.nnodes, &rpt.node_rpt, &node_ids),
        (rpt.linkflag, "LINKS", net.nlinks, &rpt.link_rpt, &link_ids),
    ] {
        match flag {
            0 => f.push_str(&format!("\n {word}               NONE")),
            1 => f.push_str(&format!("\n {word}               ALL")),
            _ => {
                let mut j = 0;
                for i in 1..=n {
                    if listed.get(i).copied().unwrap_or(false) {
                        if j % 5 == 0 {
                            f.push_str(&format!("\n {word}               "));
                        }
                        f.push_str(&format!("{} ", ids[i]));
                        j += 1;
                    }
                }
            }
        }
    }
    for field in rpt.field.iter().take(Field::Friction as usize) {
        if field.enabled {
            f.push_str(&format!(
                "\n {}PRECISION {}",
                l(field.name, 20),
                field.precision
            ));
            if field.rpt_lim[LOW] < BIG {
                f.push_str(&format!(
                    "\n {}BELOW {}",
                    l(field.name, 20),
                    cf(field.rpt_lim[LOW], 6)
                ));
            }
            if field.rpt_lim[HI] > -BIG {
                f.push_str(&format!(
                    "\n {}ABOVE {}",
                    l(field.name, 20),
                    cf(field.rpt_lim[HI], 6)
                ));
            }
        } else {
            f.push_str(&format!("\n {}NO", l(field.name, 20)));
        }
    }

    // [TAGS]
    f.push_str("\n\n[TAGS]");
    f.push_str(&format!("\n;;{}\t{}\tTag", l("Object", 8), l("ID", 31)));
    for i in 1..=net.nnodes {
        if let Some(tag) = meta.node_tag[i].as_deref().filter(|t| !t.is_empty()) {
            f.push_str(&format!(
                "\n {}\t{}\t{tag}",
                l("NODE", 8),
                l(&net.node[i].id, 31)
            ));
        }
    }
    for i in 1..=net.nlinks {
        if let Some(tag) = meta.link_tag[i].as_deref().filter(|t| !t.is_empty()) {
            f.push_str(&format!(
                "\n {}\t{}\t{tag}",
                l("LINK", 8),
                l(&net.link[i].id, 31)
            ));
        }
    }

    // [COORDINATES]
    f.push_str("\n\n[COORDINATES]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}",
        l("ID", 31),
        l("X-Coord", 14),
        l("Y-Coord", 14)
    ));
    for i in 1..=net.nnodes {
        let Some((x, y)) = meta.node_xy[i] else {
            continue;
        };
        if x == MISSING || y == MISSING {
            continue;
        }
        f.push_str(&format!(
            "\n {}\t{}\t{}",
            l(&net.node[i].id, 31),
            fl(x, 14, 6),
            fl(y, 14, 6)
        ));
    }

    // [VERTICES]
    f.push_str("\n\n[VERTICES]");
    f.push_str(&format!(
        "\n;;{}\t{}\t{}",
        l("ID", 31),
        l("X-Coord", 14),
        l("Y-Coord", 14)
    ));
    for i in 1..=net.nlinks {
        for (x, y) in &meta.link_vertices[i] {
            f.push_str(&format!(
                "\n {}\t{}\t{}",
                l(&net.link[i].id, 31),
                fl(*x, 14, 6),
                fl(*y, 14, 6)
            ));
        }
    }

    f.push('\n');
    saveauxdata(&o.inp_name, &mut f);
    f.push_str("\n[END]\n");
    f
}

/// `saveauxdata`: the `[LABELS]` and `[BACKDROP]` sections of the input file, read
/// again from disk as EPANET does (nothing if it cannot be read).
fn saveauxdata(inp_name: &str, f: &mut String) {
    let Ok(bytes) = std::fs::read(inp_name) else {
        return;
    };
    let mut sect: Option<usize> = None;
    let mut rest = bytes.as_slice();
    while !rest.is_empty() {
        // fgets(line, MAXLINE, InFile)
        let end = rest
            .iter()
            .take(MAXLINE - 1)
            .position(|&b| b == b'\n')
            .map_or(rest.len().min(MAXLINE - 1), |p| p + 1);
        let line = String::from_utf8_lossy(&rest[..end]).into_owned();
        rest = &rest[end..];
        let Some(tok) = line.split([' ', '\t', '\n', '\r']).find(|t| !t.is_empty()) else {
            continue;
        };
        if tok.starts_with('[') {
            if let Some(newsect) = SECT_TXT
                .iter()
                .position(|k| ws_model::keyword_matches(tok, k))
            {
                sect = Some(newsect);
                if newsect == S_END {
                    break;
                }
                if newsect == S_LABELS || newsect == S_BACKDROP {
                    f.push_str(&format!("\n{line}"));
                }
            }
        } else if sect == Some(S_LABELS) || sect == Some(S_BACKDROP) {
            f.push_str(&line);
        }
    }
}
