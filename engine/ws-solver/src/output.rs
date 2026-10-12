// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (output.c), Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! EPANET's binary output file: the prolog (`savenetdata`), pump energy
//! (`saveenergy`), the results of each report period (`saveoutput`), time-series
//! statistics (`savetimestat`) and the epilog (`savenetreacts`, `saveepilog`).
//!
//! As in `EN_solveQ`, reported values are computed from the hydraulic solution as the
//! hydraulics file stores it (f32), so they match EPANET's output file to the bit.

use crate::Project;
use crate::quality;
use crate::report::Tstat;
use crate::types::*;

pub const MAGICNUMBER: i32 = 516114521;
const TITLELEN: usize = 79;
const MAXID: usize = 31;
const MAXFNAME: usize = 259;

/// Node output variables, in file order (`DEMAND..QUALITY`).
pub const NODE_VARS: usize = 4;
/// Link output variables, in file order (`FLOW..FRICTION`).
pub const LINK_VARS: usize = 8;

/// Results of every report period as EPANET writes them: `nodes[v][p * nn + i]`.
#[derive(Clone, Debug, Default)]
pub struct Columns {
    pub nodes: [Vec<f32>; NODE_VARS],
    pub links: [Vec<f32>; LINK_VARS],
}

/// The current solution as `readhyd` would load it from the hydraulics file.
fn stored(x: f64) -> f64 {
    f64::from(x as f32)
}

/// `nodeoutput` for DEMAND, HEAD and PRESSURE, and `linkoutput` for FLOW, VELOCITY,
/// HEADLOSS, STATUS, SETTING and FRICTION, from the solution as stored. Appends one
/// period to `cols`.
pub fn save_hydraulics(pr: &Project, cols: &mut Columns) {
    let (net, hyd, ucf) = (&pr.net, &pr.hyd, &pr.units.ucf);
    let head: Vec<f64> = hyd.node_head.iter().map(|&h| stored(h)).collect();
    for i in 1..=net.nnodes {
        cols.nodes[0].push((stored(hyd.node_demand[i]) * ucf[Field::Demand as usize]) as f32);
        cols.nodes[1].push((head[i] * ucf[Field::Head as usize]) as f32);
        cols.nodes[2].push(((head[i] - net.node[i].el) * ucf[Field::Pressure as usize]) as f32);
    }
    for k in 1..=net.nlinks {
        let l = &net.link[k];
        let status = hyd.link_status[k];
        let flow = if status <= Status::Closed {
            0.0
        } else {
            stored(hyd.link_flow[k])
        };
        cols.links[0].push((flow * ucf[Field::Flow as usize]) as f32);
        let velocity = if l.link_type == LinkType::Pump {
            0.0
        } else {
            let a = PI * (l.diam * l.diam) / 4.0;
            (abs(flow) / a * ucf[Field::Velocity as usize]) as f32
        };
        cols.links[1].push(velocity);
        let headloss = if status <= Status::Closed {
            0.0
        } else {
            let mut h = head[l.n1] - head[l.n2];
            if l.link_type != LinkType::Pump {
                h = abs(h);
            }
            if l.link_type <= LinkType::Pipe {
                (1000.0 * h / l.len) as f32
            } else {
                (h * ucf[Field::Headloss as usize]) as f32
            }
        };
        cols.links[2].push(headloss);
        cols.links[4].push(f32::from(status as u8));
        let setting = stored(hyd.link_setting[k]);
        let setting = if setting == MISSING {
            0.0
        } else {
            match l.link_type {
                LinkType::CvPipe | LinkType::Pipe | LinkType::Pump => setting as f32,
                LinkType::Prv | LinkType::Psv | LinkType::Pbv => {
                    (setting * ucf[Field::Pressure as usize]) as f32
                }
                LinkType::Fcv => (setting * ucf[Field::Flow as usize]) as f32,
                LinkType::Tcv | LinkType::Pcv => setting as f32,
                LinkType::Gpv => 0.0,
            }
        };
        cols.links[5].push(setting);
        let friction = if l.link_type <= LinkType::Pipe && abs(flow) > TINY {
            let h = abs(head[l.n1] - head[l.n2]);
            (39.725 * h * pow(l.diam, 5.0) / l.len / (flow * flow)) as f32
        } else {
            0.0
        };
        cols.links[7].push(friction);
    }
}

/// `nodeoutput` for QUALITY and `linkoutput` for LINKQUAL and REACTRATE. Appends one
/// period to `cols`.
pub fn save_quality(pr: &Project, cols: &mut Columns) {
    let (net, q, ucf) = (&pr.net, &pr.qual, &pr.units.ucf);
    let none = q.qualflag == QualType::None;
    for i in 1..=net.nnodes {
        let c = if none { net.node[i].c0 } else { q.node_qual[i] };
        cols.nodes[3].push((c * ucf[Field::Quality as usize]) as f32);
    }
    for k in 1..=net.nlinks {
        cols.links[3].push((quality::avgqual(pr, k) * ucf[Field::LinkQual as usize]) as f32);
        let r = if none {
            0.0
        } else {
            (q.pipe_rate_coeff[k] * ucf[Field::ReactRate as usize]) as f32
        };
        cols.links[6].push(r);
    }
}

struct Writer(Vec<u8>);

impl Writer {
    fn i4(&mut self, v: i32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn r4(&mut self, v: f32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// A C string field of `len + 1` bytes, as `strncpy` + `fwrite` leave it.
    fn text(&mut self, s: &str, len: usize) {
        let b = s.as_bytes();
        let n = b.len().min(len);
        self.0.extend_from_slice(&b[..n]);
        self.0.resize(self.0.len() + len + 1 - n, 0);
    }
}

/// The quality units EPANET reports (`Field[QUALITY].Units`, set in `initunits`).
pub fn quality_units(pr: &Project) -> &str {
    match pr.qual.qualflag {
        QualType::None => "",
        QualType::Chem => &pr.qual.chem_units,
        QualType::Age => "hrs",
        QualType::Trace => "% from",
    }
}

/// `savenetdata`: the prolog.
pub fn savenetdata(pr: &Project, title: &[String], inp_name: &str) -> Vec<u8> {
    let (net, ucf) = (&pr.net, &pr.units.ucf);
    let mut w = Writer(Vec::new());
    for v in [
        MAGICNUMBER,
        20012,
        net.nnodes as i32,
        net.ntanks as i32,
        net.nlinks as i32,
        net.npumps as i32,
        net.nvalves as i32,
        pr.qual.qualflag as i32,
        pr.qual.trace_node as i32,
        pr.units.flowflag as i32,
        pr.units.pressflag as i32,
        pr.rpt.tstatflag as i32,
        pr.times.rstart as i32,
        pr.times.rstep as i32,
        pr.times.dur as i32,
    ] {
        w.i4(v);
    }
    for i in 0..3 {
        w.text(title.get(i).map_or("", String::as_str), TITLELEN);
    }
    w.text(inp_name, MAXFNAME);
    w.text(&pr.rpt.rpt2_fname, MAXFNAME);
    w.text(&pr.qual.chem_name, MAXID);
    w.text(quality_units(pr), MAXID);
    for i in 1..=net.nnodes {
        w.text(&net.node[i].id, MAXID);
    }
    for k in 1..=net.nlinks {
        w.text(&net.link[k].id, MAXID);
    }
    for k in 1..=net.nlinks {
        w.i4(net.link[k].n1 as i32);
    }
    for k in 1..=net.nlinks {
        w.i4(net.link[k].n2 as i32);
    }
    for k in 1..=net.nlinks {
        w.i4(net.link[k].link_type as i32);
    }
    for i in 1..=net.ntanks {
        w.i4(net.tank[i].node as i32);
    }
    for i in 1..=net.ntanks {
        w.r4(net.tank[i].a as f32);
    }
    for i in 1..=net.nnodes {
        w.r4((net.node[i].el * ucf[Field::Elev as usize]) as f32);
    }
    for k in 1..=net.nlinks {
        w.r4((net.link[k].len * ucf[Field::Elev as usize]) as f32);
    }
    for k in 1..=net.nlinks {
        let l = &net.link[k];
        w.r4(if l.link_type != LinkType::Pump {
            (l.diam * ucf[Field::Diam as usize]) as f32
        } else {
            0.0
        });
    }
    w.0
}

/// `saveenergy`: turn the accumulated pump energy into time averages (in place, as
/// EPANET does) and write them, then the demand charge.
pub fn saveenergy(pr: &mut Project) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    let hdur = pr.times.dur as f64 / 3600.0;
    let si = pr.units.unitsflag == UnitsType::Si;
    for i in 1..=pr.net.npumps {
        let pump = &mut pr.net.pump[i];
        let e = &mut pump.energy;
        if hdur == 0.0 {
            e.total_cost *= 24.0;
        } else {
            let t = e.time_on_line;
            e.time_on_line = t / hdur;
            if t > 0.0 {
                e.efficiency /= t;
                e.kw_hrs_per_flow /= t;
                e.kw_hrs /= t;
            }
            e.total_cost *= 24.0 / hdur;
        }
        e.time_on_line *= 100.0;
        e.efficiency *= 100.0;
        if si {
            e.kw_hrs_per_flow *= 1000. / LPS_PER_CFS / 3600.;
        } else {
            e.kw_hrs_per_flow *= 1.0e6 / GPM_PER_CFS / 60.;
        }
        w.i4(pump.link as i32);
        for v in [
            e.time_on_line,
            e.efficiency,
            e.kw_hrs_per_flow,
            e.kw_hrs,
            e.max_kwatts,
            e.total_cost,
        ] {
            w.r4(v as f32);
        }
    }
    pr.hyd.emax *= pr.hyd.dcost;
    w.r4(pr.hyd.emax as f32);
    w.0
}

/// `savetimestat`: one statistic over all periods for each variable, as the single
/// period EPANET then writes. Returns node and link columns of one period.
pub fn timestat(cols: &Columns, stat: Tstat, nn: usize, nl: usize, periods: usize) -> Columns {
    let mut out = Columns::default();
    let reduce = |series: &[f32], n: usize, link_var: Option<usize>| -> Vec<f32> {
        let mut stat1 = vec![0.0f32; n];
        let mut stat2 = vec![0.0f32; n];
        if stat != Tstat::Avg {
            stat1.fill(-MISSING as f32);
            stat2.fill(MISSING as f32);
        }
        for p in 0..periods {
            for i in 0..n {
                let mut xx = series[p * n + i];
                if link_var == Some(0) && xx < 0.0 {
                    xx = -xx;
                }
                if link_var == Some(4) {
                    xx = if xx >= Status::Open as u8 as f32 {
                        1.0
                    } else {
                        0.0
                    };
                }
                if stat == Tstat::Avg {
                    stat1[i] += xx;
                } else {
                    stat1[i] = min_c(stat1[i], xx);
                    stat2[i] = max_c(stat2[i], xx);
                }
            }
        }
        let mut x: Vec<f32> = (0..n)
            .map(|i| match stat {
                Tstat::Avg => stat1[i] / periods as f32,
                Tstat::Min => stat1[i],
                Tstat::Max => stat2[i],
                Tstat::Range => stat2[i] - stat1[i],
                Tstat::Series => 0.0,
            })
            .collect();
        if link_var == Some(4) {
            for v in &mut x {
                *v = if *v < 0.5 {
                    Status::Closed as u8 as f32
                } else {
                    Status::Open as u8 as f32
                };
            }
        }
        x
    };
    for v in 0..NODE_VARS {
        out.nodes[v] = reduce(&cols.nodes[v], nn, None);
    }
    for v in 0..LINK_VARS {
        out.links[v] = reduce(&cols.links[v], nl, Some(v));
    }
    out
}

/// The whole output file.
pub fn outfile(
    prolog: &[u8],
    energy: &[u8],
    cols: &Columns,
    nn: usize,
    nl: usize,
    periods: usize,
    reacts: [f64; 4],
    dur: i64,
    warnflag: i32,
) -> Vec<u8> {
    let mut w = Writer(Vec::with_capacity(
        prolog.len() + energy.len() + 4 * periods * (NODE_VARS * nn + LINK_VARS * nl) + 28,
    ));
    w.0.extend_from_slice(prolog);
    w.0.extend_from_slice(energy);
    for p in 0..periods {
        for col in &cols.nodes {
            for &v in &col[p * nn..(p + 1) * nn] {
                w.r4(v);
            }
        }
        for col in &cols.links {
            for &v in &col[p * nl..(p + 1) * nl] {
                w.r4(v);
            }
        }
    }
    let t = if dur > 0 { dur as f64 / 3600. } else { 1. };
    for r in reacts {
        w.r4((r / t) as f32);
    }
    w.i4(periods as i32);
    w.i4(warnflag);
    w.i4(MAGICNUMBER);
    w.0
}

/// The periods as the output file holds them: every report period, or the one
/// time-series statistic the project asks for.
pub fn file_columns<'a>(
    pr: &Project,
    cols: &'a Columns,
    periods: usize,
) -> (std::borrow::Cow<'a, Columns>, usize) {
    if pr.rpt.tstatflag == Tstat::Series {
        (std::borrow::Cow::Borrowed(cols), periods)
    } else {
        let (nn, nl) = (pr.net.nnodes, pr.net.nlinks);
        let stat = timestat(cols, pr.rpt.tstatflag, nn, nl, periods);
        (std::borrow::Cow::Owned(stat), 1)
    }
}

/// EPANET's binary output file from its prolog, the pumps' energy and the saved periods.
pub fn outfile_bytes(
    pr: &Project,
    prolog: &[u8],
    energy: &[u8],
    cols: &Columns,
    periods: usize,
    reduced: bool,
) -> Vec<u8> {
    let (nn, nl) = (pr.net.nnodes, pr.net.nlinks);
    let q = &pr.qual;
    let reacts = [q.wbulk, q.wwall, q.wtank, q.wsource];
    // `reduced`: `cols` already holds the time statistic.
    let (cols, periods) = if reduced {
        (std::borrow::Cow::Borrowed(cols), periods)
    } else {
        file_columns(pr, cols, periods)
    };
    outfile(
        prolog,
        energy,
        &cols,
        nn,
        nl,
        periods,
        reacts,
        pr.times.dur,
        pr.warnflag,
    )
}
