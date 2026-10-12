// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (report.c, input1.c, input3.c), Copyright (c) 2019
// OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.

//! EPANET's text report (`report.c`): reporting options read from [REPORT] as
//! `reportdata` does, the status log written while the hydraulics run, warnings,
//! flow and mass balances, the energy report and the node and link tables, all
//! formatted exactly as OWA-EPANET formats them.

use ws_model::{KeywordSection, keyword_matches as m};

use crate::Project;
use crate::cfmt;
use crate::error::SolverError;
use crate::input::getfloat;
use crate::output::Columns;
use crate::types::*;

pub const NODE_TXT: [&str; 3] = ["Junction", "Reservoir", "Tank"];
pub const LINK_TXT: [&str; 10] = [
    "CV", "Pipe", "Pump", "PRV", "PSV", "PBV", "FCV", "TCV", "GPV", "PCV",
];
pub const STAT_TXT: [&str; 11] = [
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
const TSTAT_TXT: [&str; 5] = ["NONE", "AVERAGE", "MINIMUM", "MAXIMUM", "RANGE"];
const MAXCOUNT: i32 = 10;

/// The report being written (EPANET's open `RptFile` and its page position).
#[derive(Clone, Debug, Default)]
pub struct ReportFile {
    pub text: String,
    line_num: i64,
    page_num: i64,
}

/// Time-series statistic (`TstatType`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Tstat {
    #[default]
    Series = 0,
    Avg = 1,
    Min = 2,
    Max = 3,
    Range = 4,
}

/// Hydraulic status reporting (`Statflag`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, PartialOrd, Ord)]
pub enum Statflag {
    #[default]
    No = 0,
    Yes = 1,
    Full = 2,
}

/// One reported variable (`SField`).
#[derive(Clone, Debug)]
pub struct ReportField {
    pub name: &'static str,
    pub units: String,
    pub enabled: bool,
    pub precision: i32,
    /// Lower and upper reporting limits.
    pub rpt_lim: [f64; 2],
}

pub const LOW: usize = 0;
pub const HI: usize = 1;

/// `Fldname` (enumstxt.h), indexed by [`Field`].
pub const FIELD_NAMES: [&str; 15] = [
    "Elevation",
    "Demand",
    "Head",
    "Pressure",
    "Quality",
    "Length",
    "Diameter",
    "Flow",
    "Velocity",
    "Headloss",
    "Quality",
    "State",
    "Setting",
    "Reaction",
    "F-Factor",
];

/// Reporting options (EPANET's `Report`).
#[derive(Clone, Debug)]
pub struct Report {
    pub page_size: i32,
    pub summaryflag: bool,
    pub messageflag: bool,
    pub statflag: Statflag,
    pub energyflag: bool,
    /// 0 none, 1 all, 2 the listed nodes.
    pub nodeflag: i32,
    pub linkflag: i32,
    pub tstatflag: Tstat,
    pub rpt2_fname: String,
    pub field: Vec<ReportField>,
    /// Nodes and links listed by `NODES`/`LINKS` (EPANET's `Node.Rpt`, `Link.Rpt`).
    pub node_rpt: Vec<bool>,
    pub link_rpt: Vec<bool>,
    /// The report text, when one is being written.
    pub file: Option<ReportFile>,
    /// The first title line, for page headers.
    pub title0: String,
    /// Clock time of the run in `ctime` form, without the newline.
    pub date: String,
}

impl Default for Report {
    /// `initreport` (input1.c).
    fn default() -> Self {
        let mut field: Vec<ReportField> = (0..MAXVAR)
            .map(|i| ReportField {
                name: FIELD_NAMES.get(i).copied().unwrap_or(""),
                units: String::new(),
                enabled: false,
                precision: 2,
                rpt_lim: [BIG * BIG, -(BIG * BIG)],
            })
            .collect();
        field[Field::Friction as usize].precision = 3;
        for i in Field::Demand as usize..=Field::Quality as usize {
            field[i].enabled = true;
        }
        for i in Field::Flow as usize..=Field::Headloss as usize {
            field[i].enabled = true;
        }
        Report {
            page_size: 0,
            summaryflag: true,
            messageflag: true,
            statflag: Statflag::No,
            energyflag: false,
            nodeflag: 0,
            linkflag: 0,
            tstatflag: Tstat::Series,
            rpt2_fname: String::new(),
            field,
            node_rpt: Vec::new(),
            link_rpt: Vec::new(),
            file: None,
            title0: String::new(),
            date: String::new(),
        }
    }
}

fn err(code: i32, message: impl Into<String>) -> SolverError {
    SolverError::new(code, message)
}

/// `strcomp`: case-insensitive equality.
fn strcomp(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// `reportdata` (input3.c) over every [REPORT] line.
pub fn reportdata(
    rpt: &mut Report,
    section: &KeywordSection,
    findnode: &dyn Fn(&str) -> Option<usize>,
    findlink: &dyn Fn(&str) -> Option<usize>,
    nnodes: usize,
    nlinks: usize,
) -> Result<(), SolverError> {
    rpt.node_rpt = vec![false; nnodes + 1];
    rpt.link_rpt = vec![false; nlinks + 1];
    for line in &section.lines {
        let tok = &line.tokens;
        if tok.len() < 2 {
            return Err(err(201, "too few items in [REPORT]"));
        }
        let n = tok.len() - 1;
        let t0 = tok[0].as_str();
        let last = tok[n].as_str();
        if m(t0, "PAGE") {
            let y = getfloat(last).ok_or_else(|| err(202, format!("illegal number {last}")))?;
            if !(0.0..=255.0).contains(&y) {
                return Err(err(213, format!("illegal page size {last}")));
            }
            rpt.page_size = y as i32;
        } else if m(t0, "STATUS") {
            if m(last, "NO") {
                rpt.statflag = Statflag::No;
            }
            if m(last, "YES") {
                rpt.statflag = Statflag::Yes;
            }
            if m(last, "FULL") {
                rpt.statflag = Statflag::Full;
            }
        } else if m(t0, "SUMM") {
            if m(last, "NO") {
                rpt.summaryflag = false;
            }
            if m(last, "YES") {
                rpt.summaryflag = true;
            }
        } else if m(t0, "MESS") {
            if m(last, "NO") {
                rpt.messageflag = false;
            }
            if m(last, "YES") {
                rpt.messageflag = true;
            }
        } else if m(t0, "ENER") {
            if m(last, "NO") {
                rpt.energyflag = false;
            }
            if m(last, "YES") {
                rpt.energyflag = true;
            }
        } else if m(t0, "NODE") {
            if m(last, "NONE") {
                rpt.nodeflag = 0;
            } else if m(last, "ALL") {
                rpt.nodeflag = 1;
            } else {
                for id in &tok[1..] {
                    let j = findnode(id).ok_or_else(|| err(203, format!("undefined node {id}")))?;
                    rpt.node_rpt[j] = true;
                }
                rpt.nodeflag = 2;
            }
        } else if m(t0, "LINK") {
            if m(last, "NONE") {
                rpt.linkflag = 0;
            } else if m(last, "ALL") {
                rpt.linkflag = 1;
            } else {
                for id in &tok[1..] {
                    let j = findlink(id).ok_or_else(|| err(204, format!("undefined link {id}")))?;
                    rpt.link_rpt[j] = true;
                }
                rpt.linkflag = 2;
            }
        } else if let Some(i) = if strcomp(t0, "Headloss") {
            Some(Field::Headloss as usize)
        } else {
            FIELD_NAMES.iter().position(|k| m(t0, k))
        } {
            let f = &mut rpt.field[i];
            if tok.len() == 1 || m(&tok[1], "YES") {
                f.enabled = true;
                continue;
            }
            if m(&tok[1], "NO") {
                f.enabled = false;
                continue;
            }
            if tok.len() < 3 {
                return Err(err(201, format!("too few items for report field {t0}")));
            }
            let j = if m(&tok[1], "BELOW") {
                Some(LOW)
            } else if m(&tok[1], "ABOVE") {
                Some(HI)
            } else if m(&tok[1], "PREC") {
                None
            } else {
                return Err(err(213, format!("illegal report field option {}", tok[1])));
            };
            let y =
                getfloat(&tok[2]).ok_or_else(|| err(202, format!("illegal number {}", tok[2])))?;
            match j {
                None => {
                    f.enabled = true;
                    f.precision = round(y) as i32;
                }
                Some(j) => f.rpt_lim[j] = y,
            }
        } else if m(t0, "FILE") {
            rpt.rpt2_fname = tok[1].chars().take(259).collect();
        } else {
            return Err(err(201, format!("unknown [REPORT] keyword {t0}")));
        }
    }
    Ok(())
}

/// The STATISTIC line of [TIMES] (`timedata`).
pub fn statistic(token: &str) -> Result<Tstat, SolverError> {
    Ok(if m(token, "NONE") || m(token, "NO") {
        Tstat::Series
    } else if m(token, "AVERAGE") {
        Tstat::Avg
    } else if m(token, "MINIMUM") {
        Tstat::Min
    } else if m(token, "MAXIMUM") {
        Tstat::Max
    } else if m(token, "RANGE") {
        Tstat::Range
    } else {
        return Err(err(213, format!("illegal statistic {token}")));
    })
}

/// `clocktime`: seconds as h:mm:ss.
pub fn clocktime(seconds: i64) -> String {
    let h = seconds / 3600;
    let m = seconds % 3600 / 60;
    let sec = seconds - 3600 * h - 60 * m;
    format!("{h:01}:{m:02}:{sec:02}")
}

/// `getnodetype`: 0 junction, 1 reservoir, 2 tank.
fn getnodetype(net: &Network, i: usize) -> usize {
    if i <= net.njuncs {
        0
    } else if net.tank[i - net.njuncs].a == 0.0 {
        1
    } else {
        2
    }
}

/// `fillstr`: `n + 1` copies of `ch`.
fn fillstr(ch: char, n: usize) -> String {
    std::iter::repeat_n(ch, n + 1).collect()
}

/// Whether a report is being written.
pub fn writing(pr: &Project) -> bool {
    pr.rpt.file.is_some()
}

/// `writeline`
pub fn writeline(pr: &mut Project, s: &str) {
    let page_size = i64::from(pr.rpt.page_size);
    let Some(f) = &mut pr.rpt.file else { return };
    if f.line_num == page_size {
        f.page_num += 1;
        f.text.push_str(&format!(
            "\n\u{c}\n  Page {}    {}\n",
            f.page_num,
            cfmt::r(cfmt::trunc(&pr.rpt.title0, 60), 60)
        ));
        f.line_num = 3;
    }
    f.text.push_str("\n  ");
    f.text.push_str(s);
    f.line_num += 1;
}

/// `writelogo`
pub fn writelogo(pr: &mut Project) {
    let date = pr.rpt.date.clone();
    if let Some(f) = &mut pr.rpt.file {
        f.page_num = 1;
        f.line_num = 2;
        f.text
            .push_str("  Page 1                                    ");
        f.text.push_str(&date);
        f.text.push('\n');
    }
    writeline(
        pr,
        "******************************************************************",
    );
    writeline(
        pr,
        "*                           E P A N E T                          *",
    );
    writeline(
        pr,
        "*                   Hydraulic and Water Quality                  *",
    );
    writeline(
        pr,
        "*                   Analysis for Pipe Networks                   *",
    );
    writeline(
        pr,
        "*                          Version 2.3.05                        *",
    );
    writeline(
        pr,
        "******************************************************************",
    );
    writeline(pr, "");
}

/// `writetime`: "Analysis begun" and "Analysis ended" lines (`ctime` keeps its newline).
pub fn writetime(pr: &mut Project, what: &str) {
    let s = format!("Analysis {what} {}\n", pr.rpt.date);
    writeline(pr, &s);
}

/// `writesummary`
pub fn writesummary(pr: &mut Project, title: &[String], inp_name: &str) {
    for t in title.iter().take(3) {
        if !t.is_empty() {
            let s = cfmt::trunc(t, 70).to_string();
            writeline(pr, &s);
        }
    }
    writeline(pr, " ");
    let net = &pr.net;
    let hyd = &pr.hyd;
    let ucf = pr.units.ucf;
    let nres = (1..=net.ntanks).filter(|&i| net.tank[i].a == 0.0).count();
    let npipes = net.nlinks - net.npumps - net.nvalves;
    let fld = |f: Field| pr.rpt.field[f as usize].units.clone();
    let mut lines = vec![
        format!("    Input Data File ................... {inp_name}"),
        format!("    Number of Junctions................ {}", net.njuncs),
        format!("    Number of Reservoirs............... {nres}"),
        format!(
            "    Number of Tanks ................... {}",
            net.ntanks - nres
        ),
        format!("    Number of Pipes ................... {npipes}"),
        format!("    Number of Pumps ................... {}", net.npumps),
        format!("    Number of Valves .................. {}", net.nvalves),
        format!(
            "    Headloss Formula .................. {}",
            match hyd.formflag {
                Formula::Hw => "Hazen-Williams",
                Formula::Dw => "Darcy-Weisbach",
                Formula::Cm => "Chezy-Manning",
            }
        ),
        format!(
            "    Nodal Demand Model ................ {}",
            if hyd.demand_model == DemandModel::Dda {
                "DDA"
            } else {
                "PDA"
            }
        ),
        format!(
            "    Hydraulic Timestep ................ {} {}",
            cfmt::f(pr.times.hstep as f64 * ucf[Field::Time as usize], 2),
            fld(Field::Time)
        ),
        format!(
            "    Hydraulic Accuracy ................ {}",
            cfmt::f(hyd.hacc, 6)
        ),
    ];
    if hyd.head_error_limit > 0.0 {
        lines.push(format!(
            "    Headloss Error Limit .............. {} {}",
            cfmt::f(hyd.head_error_limit * ucf[Field::Head as usize], 6),
            fld(Field::Head)
        ));
    }
    if hyd.flow_change_limit > 0.0 {
        lines.push(format!(
            "    Flow Change Limit ................. {} {}",
            cfmt::f(hyd.flow_change_limit * ucf[Field::Flow as usize], 6),
            fld(Field::Flow)
        ));
    }
    lines.push(format!(
        "    Status Check Frequency ............ {}",
        hyd.check_freq
    ));
    lines.push(format!(
        "    Maximum Trials Checked ............ {}",
        hyd.max_check
    ));
    lines.push(format!(
        "    Damping Limit Threshold ........... {}",
        cfmt::f(hyd.damp_limit, 6)
    ));
    lines.push(format!(
        "    Maximum Trials .................... {}",
        hyd.max_iter
    ));
    let q = &pr.qual;
    let dur = pr.times.dur;
    lines.push(if q.qualflag == QualType::None || dur == 0 {
        "    Quality Analysis .................. None".to_string()
    } else {
        match q.qualflag {
            QualType::Chem => format!("    Quality Analysis .................. {}", q.chem_name),
            QualType::Trace => format!(
                "    Quality Analysis .................. Trace From Node {}",
                net.node[q.trace_node].id
            ),
            _ => "    Quality Analysis .................. Age".to_string(),
        }
    });
    if q.qualflag != QualType::None && dur > 0 {
        lines.push(format!(
            "    Water Quality Time Step ........... {} min",
            cfmt::f(f64::from(pr.times.qstep as f32) / 60.0, 2)
        ));
        lines.push(format!(
            "    Water Quality Tolerance ........... {} {}",
            cfmt::f(q.ctol * ucf[Field::Quality as usize], 2),
            fld(Field::Quality)
        ));
    }
    lines.push(format!(
        "    Specific Gravity .................. {}",
        cfmt::f(hyd.sp_grav, 2)
    ));
    lines.push(format!(
        "    Relative Kinematic Viscosity ...... {}",
        cfmt::f(hyd.viscos / VISCOS, 2)
    ));
    lines.push(format!(
        "    Relative Chemical Diffusivity ..... {}",
        cfmt::f(q.diffus / crate::quality::DIFFUS, 2)
    ));
    lines.push(format!(
        "    Demand Multiplier ................. {}",
        cfmt::f(hyd.dmult, 2)
    ));
    lines.push(format!(
        "    Total Duration .................... {} {}",
        cfmt::f(dur as f64 * ucf[Field::Time as usize], 2),
        fld(Field::Time)
    ));
    lines.push("    Reporting Criteria:".to_string());
    for l in &lines {
        writeline(pr, l);
    }
    match pr.rpt.nodeflag {
        0 => writeline(pr, "       No Nodes"),
        1 => writeline(pr, "       All Nodes"),
        _ => writeline(pr, "       Selected Nodes"),
    }
    writelimits(pr, Field::Demand as usize, Field::Quality as usize);
    match pr.rpt.linkflag {
        0 => writeline(pr, "       No Links"),
        1 => writeline(pr, "       All Links"),
        _ => writeline(pr, "       Selected Links"),
    }
    writelimits(pr, Field::Diam as usize, Field::Headloss as usize);
    writeline(pr, " ");
}

/// `writehydstat`
pub fn writehydstat(pr: &mut Project, iter: i32, relerr: f64) {
    let atime = clocktime(pr.times.htime);
    if iter > 0 {
        let s = if relerr <= pr.hyd.hacc {
            format!("{}: Balanced after {iter} trials", cfmt::r(&atime, 10))
        } else {
            format!(
                "{}: Unbalanced after {iter} trials (flow change = {})",
                cfmt::r(&atime, 10),
                cfmt::f(relerr, 6)
            )
        };
        writeline(pr, &s);
        if pr.hyd.demand_model == DemandModel::Pda && pr.hyd.deficient_nodes > 0 {
            let s = if pr.hyd.deficient_nodes == 1 {
                format!(
                    "            1 node had its demand reduced by a total of {}%",
                    cfmt::f(pr.hyd.demand_reduction, 2)
                )
            } else {
                format!(
                    "            {} nodes had demands reduced by a total of {}%",
                    pr.hyd.deficient_nodes,
                    cfmt::f(pr.hyd.demand_reduction, 2)
                )
            };
            writeline(pr, &s);
        }
    }
    let nl = pr.net.nlinks;
    for i in 1..=pr.net.ntanks {
        let n = pr.net.tank[i].node;
        let d = pr.hyd.node_demand[n];
        let old = pr.hyd.old_status[nl + i];
        let newstat = if abs(d) < 0.001 {
            Status::Closed
        } else if d < 0.0 {
            Status::Emptying
        } else if d > 0.0 {
            if pr.net.tank[i].a > 0.0 && abs(pr.hyd.node_head[n] - pr.net.tank[i].hmax) < 0.001 {
                Status::Overflowing
            } else {
                Status::Filling
            }
        } else {
            old
        };
        if newstat != old {
            let node = &pr.net.node[n];
            let s = if pr.net.tank[i].a > 0.0 {
                format!(
                    "{}: Tank {} is {} at {} {}",
                    cfmt::r(&atime, 10),
                    node.id,
                    STAT_TXT[newstat as usize],
                    cfmt::f(
                        (pr.hyd.node_head[n] - node.el) * pr.units.ucf[Field::Head as usize],
                        2
                    ),
                    pr.rpt.field[Field::Head as usize].units
                )
            } else {
                format!(
                    "{}: Reservoir {} is {}",
                    cfmt::r(&atime, 10),
                    node.id,
                    STAT_TXT[newstat as usize]
                )
            };
            writeline(pr, &s);
            pr.hyd.old_status[nl + i] = newstat;
        }
    }
    for i in 1..=nl {
        let (st, old) = (pr.hyd.link_status[i], pr.hyd.old_status[i]);
        if st != old {
            let l = &pr.net.link[i];
            let s = if pr.times.htime == 0 {
                format!(
                    "{}: {} {} {}",
                    cfmt::r(&atime, 10),
                    LINK_TXT[l.link_type as usize],
                    l.id,
                    STAT_TXT[st as usize]
                )
            } else {
                format!(
                    "{}: {} {} changed from {} to {}",
                    cfmt::r(&atime, 10),
                    LINK_TXT[l.link_type as usize],
                    l.id,
                    STAT_TXT[old as usize],
                    STAT_TXT[st as usize]
                )
            };
            writeline(pr, &s);
            pr.hyd.old_status[i] = st;
        }
    }
    writeline(pr, " ");
}

/// `writeflowbalance`
pub fn writeflowbalance(pr: &mut Project) {
    let ucf = pr.units.ucf[Field::Flow as usize];
    let fb = pr.hyd.flow_balance.clone();
    let lines = [
        format!(
            "Hydraulic Flow Balance ({})",
            pr.rpt.field[Field::Demand as usize].units
        ),
        "================================".to_string(),
        format!(
            "Total Inflow:      {}",
            cfmt::r(&cfmt::f(fb.total_inflow * ucf, 3), 12)
        ),
        format!(
            "Consumer Demand:   {}",
            cfmt::r(&cfmt::f(fb.consumer_demand * ucf, 3), 12)
        ),
        format!(
            "Demand Deficit:    {}",
            cfmt::r(&cfmt::f(fb.deficit_demand * ucf, 3), 12)
        ),
        format!(
            "Emitter Flow:      {}",
            cfmt::r(&cfmt::f(fb.emitter_demand * ucf, 3), 12)
        ),
        format!(
            "Leakage Flow:      {}",
            cfmt::r(&cfmt::f(fb.leakage_demand * ucf, 3), 12)
        ),
        format!(
            "Total Outflow:     {}",
            cfmt::r(&cfmt::f(fb.total_outflow * ucf, 3), 12)
        ),
        format!(
            "Storage Flow:      {}",
            cfmt::r(&cfmt::f(fb.storage_demand * ucf, 3), 12)
        ),
        format!("Flow Ratio:        {}", cfmt::r(&cfmt::f(fb.ratio, 3), 12)),
        "================================\n".to_string(),
    ];
    for l in &lines {
        writeline(pr, l);
    }
}

/// `writemassbalance`
pub fn writemassbalance(pr: &mut Project) {
    let q = &pr.qual;
    let units = match q.qualflag {
        QualType::Trace => " (mg)",
        QualType::Age => " (hrs)",
        _ if m(&q.chem_units, "mg") => " (mg)",
        _ if m(&q.chem_units, "ug") => " (ug)",
        _ => "",
    };
    let mb = &q.mass;
    let e = |v: f64| cfmt::r(&cfmt::e(v, 5), 12);
    let lines = [
        format!("Water Quality Mass Balance{units}"),
        "================================".to_string(),
        format!("Initial Mass:      {}", e(mb.initial)),
        format!("Mass Inflow:       {}", e(mb.inflow)),
        format!("Mass Outflow:      {}", e(mb.outflow)),
        format!("Mass Reacted:      {}", e(mb.reacted)),
        format!("Final Mass:        {}", e(mb.final_)),
        format!("Mass Ratio:         {}", cfmt::f(mb.ratio, 5)),
        format!("Total Segments:     {}", mb.seg_count),
        "================================\n".to_string(),
    ];
    for l in &lines {
        writeline(pr, l);
    }
}

/// `writeenergy`
pub fn writeenergy(pr: &mut Project) {
    if pr.net.npumps == 0 {
        return;
    }
    writeline(pr, " ");
    writeheader(pr, Header::Energy, false);
    let mut csum = 0.0;
    for j in 1..=pr.net.npumps {
        let pump = &pr.net.pump[j];
        let e = &pump.energy;
        csum += e.total_cost;
        let s = format!(
            "{}  {} {} {} {} {} {}",
            cfmt::l(&pr.net.link[pump.link].id, 8),
            cfmt::r(&cfmt::f(e.time_on_line, 2), 6),
            cfmt::r(&cfmt::f(e.efficiency, 2), 6),
            cfmt::r(&cfmt::f(e.kw_hrs_per_flow, 2), 9),
            cfmt::r(&cfmt::f(e.kw_hrs, 2), 9),
            cfmt::r(&cfmt::f(e.max_kwatts, 2), 9),
            cfmt::r(&cfmt::f(e.total_cost, 2), 9)
        );
        if pr
            .rpt
            .file
            .as_ref()
            .is_some_and(|f| f.line_num == i64::from(pr.rpt.page_size))
        {
            writeheader(pr, Header::Energy, true);
        }
        writeline(pr, &s);
    }
    writeline(pr, &fillstr('-', 63));
    let dc = pr.hyd.emax * pr.hyd.dcost;
    let s = format!(
        "{} Demand Charge: {}",
        cfmt::r("", 38),
        cfmt::r(&cfmt::f(dc, 2), 9)
    );
    writeline(pr, &s);
    let s = format!(
        "{} Total Cost:    {}",
        cfmt::r("", 38),
        cfmt::r(&cfmt::f(csum + dc, 2), 9)
    );
    writeline(pr, &s);
    writeline(pr, " ");
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Header {
    Status,
    Energy,
    Node,
    Link,
}

/// `writeheader`
pub fn writeheader(pr: &mut Project, kind: Header, contin: bool) {
    let page_size = i64::from(pr.rpt.page_size);
    if pr
        .rpt
        .file
        .as_ref()
        .is_some_and(|f| f.line_num + 11 > page_size)
    {
        while pr.rpt.file.as_ref().is_some_and(|f| f.line_num < page_size) {
            writeline(pr, " ");
        }
    }
    writeline(pr, " ");
    let cont = if contin { " (continued)" } else { "" };
    match kind {
        Header::Status => {
            writeline(pr, &format!("Hydraulic Status:{cont}"));
            writeline(pr, &fillstr('-', 70));
        }
        Header::Energy => {
            let s1 = if pr.units.unitsflag == UnitsType::Si {
                "  /m3"
            } else {
                "/Mgal"
            };
            writeline(pr, &format!("Energy Usage:{cont}"));
            writeline(pr, &fillstr('-', 63));
            writeline(
                pr,
                "           Usage   Avg.     Kw-hr      Avg.      Peak      Cost",
            );
            writeline(
                pr,
                &format!("Pump      Factor Effic.     {s1}        Kw        Kw      /day"),
            );
            writeline(pr, &fillstr('-', 63));
        }
        Header::Node | Header::Link => {
            let node = kind == Header::Node;
            let what = if node { "Node" } else { "Link" };
            let s = match pr.rpt.tstatflag {
                Tstat::Range => format!("DIFFERENTIAL {what} Results:"),
                Tstat::Series if pr.times.dur == 0 => format!("{what} Results:"),
                Tstat::Series => format!("{what} Results at {} hrs:", clocktime(pr.times.htime)),
                t => format!("{} {what} Results:", TSTAT_TXT[t as usize]),
            };
            writeline(pr, &format!("{s}{cont}"));
            let mut n = 15;
            let mut s2 = cfmt::r("", 15);
            let mut s3 = cfmt::l(what, 15);
            let fields = if node {
                Field::Elev as usize..Field::Quality as usize
            } else {
                Field::Length as usize..Field::Friction as usize + 1
            };
            for i in fields {
                let f = &pr.rpt.field[i];
                if f.enabled {
                    n += 10;
                    s2.push_str(&cfmt::r(f.name, 10));
                    s3.push_str(&cfmt::r(&f.units, 10));
                }
            }
            if node && pr.rpt.field[Field::Quality as usize].enabled {
                n += 10;
                s2.push_str(&cfmt::r(&pr.qual.chem_name, 10));
                s3.push_str(&cfmt::r(&pr.qual.chem_units, 10));
            }
            let s1 = fillstr('-', n);
            writeline(pr, &s1);
            writeline(pr, &s2);
            writeline(pr, &s3);
            writeline(pr, &s1);
        }
    }
}

/// `writerelerr`
pub fn writerelerr(pr: &mut Project, iter: i32, relerr: f64) {
    let s = if iter == 0 {
        format!(
            "{}: Balancing the network:\n",
            cfmt::r(&clocktime(pr.times.htime), 10)
        )
    } else {
        format!(
            "            Trial {}: relative flow change = {}",
            cfmt::r(&iter.to_string(), 2),
            cfmt::f(relerr, 6)
        )
    };
    writeline(pr, &s);
}

/// `writestatchange`
pub fn writestatchange(pr: &mut Project, k: usize, s1: Status, s2: Status) {
    let l = &pr.net.link[k];
    let lt = LINK_TXT[l.link_type as usize];
    if s1 == s2 {
        let mut setting = pr.hyd.link_setting[k];
        match l.link_type {
            LinkType::Prv | LinkType::Psv | LinkType::Pbv => {
                setting *= pr.units.ucf[Field::Pressure as usize]
            }
            LinkType::Fcv => setting *= pr.units.ucf[Field::Flow as usize],
            _ => {}
        }
        let s = format!(
            "            {lt} {} setting changed to {}",
            l.id,
            cfmt::f(setting, 2)
        );
        writeline(pr, &s);
        return;
    }
    let simple = |s: Status| {
        if s == Status::Active {
            Status::Active
        } else if s <= Status::Closed {
            Status::Closed
        } else {
            Status::Open
        }
    };
    let (j1, j2) = (simple(s1), simple(s2));
    if j1 != j2 {
        let s = format!(
            "            {lt} {} switched from {} to {}",
            l.id, STAT_TXT[j1 as usize], STAT_TXT[j2 as usize]
        );
        writeline(pr, &s);
    }
}

/// `writecontrolaction`
pub fn writecontrolaction(pr: &mut Project, k: usize, i: usize) {
    let net = &pr.net;
    let c = &net.control[i];
    let l = &net.link[k];
    let atime = cfmt::r(&clocktime(pr.times.htime), 10);
    let s = match c.control_type {
        ControlType::LowLevel | ControlType::HiLevel => format!(
            "{atime}: {} {} changed by {} {} control",
            LINK_TXT[l.link_type as usize],
            l.id,
            NODE_TXT[getnodetype(net, c.node)],
            net.node[c.node].id
        ),
        ControlType::Timer | ControlType::TimeOfDay => format!(
            "{atime}: {} {} changed by timer control",
            LINK_TXT[l.link_type as usize], l.id
        ),
    };
    writeline(pr, &s);
}

/// `writeruleaction`
pub fn writeruleaction(pr: &mut Project, k: usize, rule_id: &str) {
    let l = &pr.net.link[k];
    let s = format!(
        "{}: {} {} changed by rule {rule_id}",
        cfmt::r(&clocktime(pr.times.htime), 10),
        LINK_TXT[l.link_type as usize],
        l.id
    );
    writeline(pr, &s);
}

/// `writehydwarn`: report the warning conditions of the solution just found. Returns
/// the warning code (0 if none) and records it as the project's warning flag.
pub fn writehydwarn(pr: &mut Project, iter: i32, relerr: f64) -> i32 {
    let mut flag = 0;
    let msg = pr.rpt.messageflag && writing(pr);
    let atime = clocktime(pr.times.htime);
    if iter > pr.hyd.max_iter && relerr <= pr.hyd.hacc {
        if msg {
            writeline(
                pr,
                &format!(
                    "WARNING: Maximum trials exceeded at {atime} hrs. System may be unstable."
                ),
            );
        }
        flag = 2;
    }
    if pr.hyd.demand_model == DemandModel::Dda {
        let (net, hyd) = (&pr.net, &mut pr.hyd);
        hyd.deficient_nodes = 0;
        for i in 1..=net.njuncs {
            if hyd.node_head[i] < net.node[i].el && hyd.node_demand[i] > 0.0 {
                hyd.deficient_nodes += 1;
            }
        }
        if hyd.deficient_nodes > 0 {
            if msg {
                writeline(pr, &format!("WARNING: Negative pressures at {atime} hrs."));
            }
            flag = 6;
        }
    }
    for i in 1..=pr.net.nvalves {
        let j = pr.net.valve[i].link;
        let st = pr.hyd.link_status[j];
        if st >= Status::XFcv {
            if msg {
                let l = &pr.net.link[j];
                let s = format!(
                    "WARNING: {} {} {} at {atime} hrs.",
                    LINK_TXT[l.link_type as usize], l.id, STAT_TXT[st as usize]
                );
                writeline(pr, &s);
            }
            flag = 5;
        }
    }
    for i in 1..=pr.net.npumps {
        let pump = &pr.net.pump[i];
        let j = pump.link;
        let hyd = &pr.hyd;
        let mut s = hyd.link_status[j];
        if hyd.link_status[j] >= Status::Open {
            if hyd.link_flow[j] > hyd.link_setting[j] * pump.qmax {
                s = Status::XFlow;
            }
            if hyd.link_flow[j] < 0.0 {
                s = Status::XHead;
            }
        }
        if s == Status::XHead || s == Status::XFlow {
            if msg {
                let line = format!(
                    "WARNING: Pump {} {} at {atime} hrs.",
                    pr.net.link[j].id, STAT_TXT[s as usize]
                );
                writeline(pr, &line);
            }
            flag = 4;
        }
    }
    if iter > pr.hyd.max_iter && relerr > pr.hyd.hacc {
        if msg {
            let mut s = format!("WARNING: System unbalanced at {atime} hrs.");
            if pr.hyd.extra_iter == -1 {
                s.push_str(" EXECUTION HALTED.");
            }
            writeline(pr, &s);
        }
        flag = 1;
    }
    if flag > 0 {
        if writing(pr) {
            disconnected(pr);
        }
        pr.warnflag = flag;
        if msg {
            writeline(pr, " ");
        }
    }
    flag
}

/// `disconnected`: report junctions cut off from every tank and reservoir.
fn disconnected(pr: &mut Project) -> i32 {
    let (nn, njuncs, ntanks) = (pr.net.nnodes, pr.net.njuncs, pr.net.ntanks);
    let mut nodelist = vec![0usize; nn + 1];
    let mut marked = vec![0u8; nn + 1];
    for i in 1..=ntanks {
        let j = njuncs + i;
        nodelist[i] = j;
        marked[j] = 1;
    }
    let mut mcount = ntanks;
    for i in 1..=njuncs {
        if pr.hyd.node_demand[i] < 0.0 {
            mcount += 1;
            nodelist[mcount] = i;
            marked[i] = 1;
        }
    }
    marknodes(pr, mcount, &mut nodelist, &mut marked);
    let mut j = 0;
    let mut count = 0;
    let atime = clocktime(pr.times.htime);
    for i in 1..=njuncs {
        if marked[i] == 0 && pr.hyd.node_demand[i] != 0.0 {
            count += 1;
            if count <= MAXCOUNT && pr.rpt.messageflag {
                let s = format!(
                    "WARNING: Node {} disconnected at {atime} hrs",
                    pr.net.node[i].id
                );
                writeline(pr, &s);
            }
            j = i;
        }
    }
    if count > 0 && pr.rpt.messageflag {
        if count > MAXCOUNT {
            let s = format!(
                "WARNING: {} additional nodes disconnected at {atime} hrs",
                count - MAXCOUNT
            );
            writeline(pr, &s);
        }
        getclosedlink(pr, j, &mut marked, &mut nodelist);
    }
    count
}

/// `marknodes`
fn marknodes(pr: &Project, mut m: usize, nodelist: &mut [usize], marked: &mut [u8]) {
    let mut n = 1;
    while n <= m {
        let i = nodelist[n];
        for &(j, k) in &pr.adjlist[i] {
            if marked[j] != 0 {
                continue;
            }
            let l = &pr.net.link[k];
            if matches!(
                l.link_type,
                LinkType::CvPipe | LinkType::Prv | LinkType::Psv
            ) && j == l.n1
            {
                continue;
            }
            if pr.hyd.link_status[k] > Status::Closed {
                marked[j] = 1;
                m += 1;
                nodelist[m] = j;
            }
        }
        n += 1;
    }
}

/// `getclosedlink`
fn getclosedlink(pr: &mut Project, i: usize, marked: &mut [u8], stack: &mut [usize]) {
    let mut top: isize = 0;
    marked[i] = 2;
    stack[0] = i;
    while top >= 0 {
        let i = stack[top as usize];
        top -= 1;
        for a in 0..pr.adjlist[i].len() {
            let (j, k) = pr.adjlist[i][a];
            if marked[j] == 2 {
                continue;
            }
            if marked[j] == 1 {
                let s = format!(
                    "WARNING: System disconnected because of Link {}",
                    pr.net.link[k].id
                );
                writeline(pr, &s);
                return;
            }
            marked[j] = 2;
            top += 1;
            stack[top as usize] = j;
        }
    }
}

/// `writelimits`
fn writelimits(pr: &mut Project, j1: usize, j2: usize) {
    for j in j1..=j2 {
        let f = pr.rpt.field[j].clone();
        if f.rpt_lim[LOW] < BIG {
            let s = format!(
                "       with {} below {} {}",
                f.name,
                cfmt::f(f.rpt_lim[LOW], 2),
                f.units
            );
            writeline(pr, &s);
        }
        if f.rpt_lim[HI] > -BIG {
            let s = format!(
                "       with {} above {} {}",
                f.name,
                cfmt::f(f.rpt_lim[HI], 2),
                f.units
            );
            writeline(pr, &s);
        }
    }
}

/// `checklimits`
fn checklimits(rpt: &Report, y: &[f64], j1: usize, j2: usize) -> bool {
    (j1..=j2).all(|j| !(y[j] > rpt.field[j].rpt_lim[LOW] || y[j] < rpt.field[j].rpt_lim[HI]))
}

/// A reported value: `%10.2e` beyond a million, else `%10.*f`.
fn value(y: f64, precision: i32) -> String {
    if y.abs() > 1.0e6 {
        cfmt::r(&cfmt::e(y, 2), 10)
    } else {
        cfmt::r(&cfmt::f(y, precision.max(0) as usize), 10)
    }
}

/// `writeresults`: node and link tables for every reported period, from the output
/// file's values.
pub fn writeresults(pr: &mut Project, cols: &Columns, nperiods: usize) {
    let rpt = &pr.rpt;
    if rpt.nodeflag == 0 && rpt.linkflag == 0 {
        return;
    }
    let nnv = (Field::Elev as usize..=Field::Quality as usize)
        .filter(|&j| rpt.field[j].enabled)
        .count();
    let nlv = (Field::Length as usize..=Field::Friction as usize)
        .filter(|&j| rpt.field[j].enabled)
        .count();
    if nnv == 0 && nlv == 0 {
        return;
    }
    let (nn, nl) = (pr.net.nnodes, pr.net.nlinks);
    pr.times.htime = pr.times.rstart;
    for p in 0..nperiods {
        if nnv > 0 && pr.rpt.nodeflag > 0 {
            writenodetable(pr, cols, p, nn);
        }
        if nlv > 0 && pr.rpt.linkflag > 0 {
            writelinktable(pr, cols, p, nl);
        }
        pr.times.htime += pr.times.rstep;
    }
}

fn writenodetable(pr: &mut Project, cols: &Columns, p: usize, nn: usize) {
    writeheader(pr, Header::Node, false);
    let mut y = [0.0f64; MAXVAR];
    for i in 1..=nn {
        y[Field::Elev as usize] = pr.net.node[i].el * pr.units.ucf[Field::Elev as usize];
        for (v, j) in (Field::Demand as usize..=Field::Quality as usize).enumerate() {
            y[j] = f64::from(cols.nodes[v][p * nn + i - 1]);
        }
        let rpt = &pr.rpt;
        if (rpt.nodeflag == 1 || rpt.node_rpt[i])
            && checklimits(rpt, &y, Field::Elev as usize, Field::Quality as usize)
        {
            if pr
                .rpt
                .file
                .as_ref()
                .is_some_and(|f| f.line_num == i64::from(pr.rpt.page_size))
            {
                writeheader(pr, Header::Node, true);
            }
            let mut s = cfmt::l(&pr.net.node[i].id, 15);
            for j in Field::Elev as usize..=Field::Quality as usize {
                let f = &pr.rpt.field[j];
                if f.enabled {
                    s.push_str(&value(y[j], f.precision));
                }
            }
            if i > pr.net.njuncs {
                s.push_str("  ");
                s.push_str(NODE_TXT[getnodetype(&pr.net, i)]);
            }
            writeline(pr, &s);
        }
    }
    writeline(pr, " ");
}

fn writelinktable(pr: &mut Project, cols: &Columns, p: usize, nl: usize) {
    writeheader(pr, Header::Link, false);
    let mut y = [0.0f64; MAXVAR];
    for i in 1..=nl {
        let l = &pr.net.link[i];
        y[Field::Length as usize] = l.len * pr.units.ucf[Field::Length as usize];
        y[Field::Diam as usize] = l.diam * pr.units.ucf[Field::Diam as usize];
        for (v, j) in (Field::Flow as usize..=Field::Friction as usize).enumerate() {
            y[j] = f64::from(cols.links[v][p * nl + i - 1]);
        }
        let rpt = &pr.rpt;
        if (rpt.linkflag == 1 || rpt.link_rpt[i])
            && checklimits(rpt, &y, Field::Diam as usize, Field::Friction as usize)
        {
            if pr
                .rpt
                .file
                .as_ref()
                .is_some_and(|f| f.line_num == i64::from(pr.rpt.page_size))
            {
                writeheader(pr, Header::Link, true);
            }
            let l = &pr.net.link[i];
            let mut s = cfmt::l(&l.id, 15);
            for j in Field::Length as usize..=Field::Friction as usize {
                let f = &pr.rpt.field[j];
                if !f.enabled {
                    continue;
                }
                if j == Field::Status as usize {
                    let k = if y[j] <= f64::from(Status::Closed as u8) {
                        Status::Closed
                    } else if y[j] == f64::from(Status::Active as u8) {
                        Status::Active
                    } else {
                        Status::Open
                    };
                    s.push_str(&cfmt::r(STAT_TXT[k as usize], 10));
                } else {
                    s.push_str(&value(y[j], f.precision));
                }
            }
            if l.link_type > LinkType::Pipe {
                s.push_str("  ");
                s.push_str(LINK_TXT[l.link_type as usize]);
            }
            writeline(pr, &s);
        }
    }
    writeline(pr, " ");
}

/// `initunits`: the units each reported field is labelled with.
/// The quality fields' units after `EN_setqualtype` changes the analysis.
pub fn setqualityunits(pr: &mut Project) {
    let q = &pr.qual;
    let (qu, rr) = match q.qualflag {
        QualType::Chem => (q.chem_units.clone(), Some(format!("{}/day", q.chem_units))),
        QualType::Trace => ("% from".to_string(), None),
        QualType::Age => ("hrs".to_string(), None),
        QualType::None => return,
    };
    pr.rpt.field[Field::Quality as usize].units = qu;
    if let Some(rr) = rr {
        pr.rpt.field[Field::ReactRate as usize].units = rr;
    }
}

pub fn setfieldunits(pr: &mut Project) {
    let u = &pr.units;
    let si = u.unitsflag == UnitsType::Si;
    let flow = [
        "cfs", "gpm", "mgd", "Imgd", "a-f/d", "L/s", "Lpm", "ML/d", "m3/h", "m3/d", "m3/s",
    ][u.flowflag as usize];
    let press = ["PSI", "KPA", "METERS", "BAR", "FEET", "PSI"][u.pressflag as usize];
    let time = if pr.times.hstep < 1800 { "min" } else { "hrs" };
    let q = &pr.qual;
    let mut set = |f: Field, s: &str| pr.rpt.field[f as usize].units = s.to_string();
    set(Field::Demand, flow);
    set(Field::Elev, if si { "m" } else { "ft" });
    set(Field::Head, if si { "m" } else { "ft" });
    set(Field::Length, if si { "m" } else { "ft" });
    set(Field::Diam, if si { "mm" } else { "in" });
    set(Field::Flow, flow);
    set(Field::Velocity, if si { "m/s" } else { "fps" });
    set(Field::Headloss, if si { "/1000m" } else { "/1000ft" });
    set(Field::Friction, "");
    set(Field::Power, if si { "kw" } else { "hp" });
    set(Field::Pressure, press);
    match q.qualflag {
        QualType::None => set(Field::Quality, ""),
        QualType::Chem => {
            let cu = q.chem_units.clone();
            set(Field::Quality, &cu);
            set(Field::ReactRate, &format!("{cu}/day"));
        }
        QualType::Age => set(Field::Quality, "hrs"),
        QualType::Trace => set(Field::Quality, "% from"),
    }
    set(Field::Time, time);
}
