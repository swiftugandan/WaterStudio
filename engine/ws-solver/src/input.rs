// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (input1.c, input2.c, input3.c, validate.c),
// Copyright (c) 2019 OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.

//! Builds EPANET's internal network from the canonical model: option, time,
//! energy and control parsing as in `input3.c`, then `adjustdata`,
//! `inittanks`, `initunits`, `convertunits` (input1.c) and `validateproject`
//! (validate.c).

use std::collections::HashMap;

use ws_model::{
    KeywordSection, LinkKind, MixModel as ModelMix, Model, NodeKind, OpenClosed, PipeStatus,
    PumpCurve, SourceKind, ValveSetting, ValveType, keyword_matches as m,
};

use crate::Project;
use crate::error::SolverError;
use crate::quality::{AGETOL, CHEMTOL, DIFFUS, L_PER_FT3, MixModel, Source, SourceType};
use crate::types::*;

fn getfloat(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `hour` (input2.c): a time string in hours, or -1 on error.
pub fn hour(time: &str, units: &str) -> f64 {
    let mut y = [0.0f64; 3];
    let mut n = 0usize;
    for s in time.split(':').filter(|s| !s.is_empty()) {
        if n >= 3 {
            break;
        }
        match getfloat(s) {
            Some(v) => y[n] = v,
            None => return -1.0,
        }
        n += 1;
    }
    if n == 1 {
        if units.is_empty() {
            return y[0];
        }
        if m(units, "SEC") {
            return y[0] / 3600.0;
        }
        if m(units, "MIN") {
            return y[0] / 60.0;
        }
        if m(units, "HOU") {
            return y[0];
        }
        if m(units, "DAY") {
            return y[0] * 24.0;
        }
    }
    if n > 1 {
        y[0] = y[0] + y[1] / 60.0 + y[2] / 3600.0;
    }
    if units.is_empty() {
        return y[0];
    }
    if m(units, "AM") {
        if y[0] >= 13.0 {
            return -1.0;
        }
        return if y[0] >= 12.0 { y[0] - 12.0 } else { y[0] };
    }
    if m(units, "PM") {
        if y[0] >= 13.0 {
            return -1.0;
        }
        return if y[0] >= 12.0 { y[0] } else { y[0] + 12.0 };
    }
    -1.0
}

/// Option settings that only matter while building.
pub struct Settings {
    pub def_pat_id: String,
    /// The TRACE node's ID, resolved once nodes exist.
    pub trace_id: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            def_pat_id: "1".to_string(),
            trace_id: None,
        }
    }
}

fn err(code: i32, message: impl Into<String>) -> SolverError {
    SolverError::new(code, message)
}

/// `getunitsoption` (input2.c).
fn units_option(s: &str) -> Option<FlowUnits> {
    let table = [
        ("CFS", FlowUnits::Cfs),
        ("GPM", FlowUnits::Gpm),
        ("AFD", FlowUnits::Afd),
        ("MGD", FlowUnits::Mgd),
        ("IMGD", FlowUnits::Imgd),
        ("LPS", FlowUnits::Lps),
        ("LPM", FlowUnits::Lpm),
        ("CMH", FlowUnits::Cmh),
        ("CMD", FlowUnits::Cmd),
        ("MLD", FlowUnits::Mld),
        ("CMS", FlowUnits::Cms),
        // getunitsoption accepts SI as a synonym for LPS.
        ("SI", FlowUnits::Lps),
    ];
    table.iter().find(|(k, _)| m(s, k)).map(|(_, u)| *u)
}

/// `optiondata`, `optionchoice` and `optionvalue` (input3.c), applied to every
/// [OPTIONS] line in order.
fn options(
    pr: &mut Project,
    set: &mut Settings,
    section: &KeywordSection,
) -> Result<(), SolverError> {
    for line in &section.lines {
        let tok = &line.tokens;
        if tok.is_empty() {
            continue;
        }
        let n = tok.len() - 1;
        match option_choice(pr, set, tok, n)? {
            true => continue,
            false => option_value(pr, set, tok, n)?,
        }
    }
    Ok(())
}

/// Returns Ok(true) when the line was a choice option (EPANET returns >= 0).
fn option_choice(
    pr: &mut Project,
    set: &mut Settings,
    tok: &[String],
    n: usize,
) -> Result<bool, SolverError> {
    let hyd = &mut pr.hyd;
    let t0 = tok[0].as_str();
    if m(t0, "UNIT") {
        if n < 1 {
            return Ok(true);
        }
        pr.units.flowflag = units_option(&tok[1])
            .ok_or_else(|| err(213, format!("illegal flow units {}", tok[1])))?;
    } else if m(t0, "PRESSURE") {
        if n < 1 {
            return Ok(true);
        }
        let t1 = tok[1].as_str();
        if m(t1, "EXP") {
            return Ok(false);
        }
        pr.units.pressflag = if m(t1, "PSI") {
            PressUnits::Psi
        } else if m(t1, "KPA") {
            PressUnits::Kpa
        } else if m(t1, "METERS") {
            PressUnits::Meters
        } else if m(t1, "BAR") {
            PressUnits::Bar
        } else if m(t1, "FEET") {
            PressUnits::Feet
        } else {
            return Err(err(213, format!("illegal pressure units {t1}")));
        };
    } else if m(t0, "HEADL") {
        if n < 1 {
            return Ok(true);
        }
        let t1 = tok[1].as_str();
        hyd.formflag = if m(t1, "H-W") {
            Formula::Hw
        } else if m(t1, "D-W") {
            Formula::Dw
        } else if m(t1, "C-M") {
            Formula::Cm
        } else {
            return Err(err(213, format!("illegal headloss formula {t1}")));
        };
    } else if m(t0, "HYDR") {
        // Hydraulics file USE/SAVE: not applicable here.
    } else if m(t0, "QUAL") {
        if n < 1 {
            return Ok(true);
        }
        let t1 = tok[1].as_str();
        let q = &mut pr.qual;
        q.qualflag = if m(t1, "NONE") {
            QualType::None
        } else if m(t1, "CHEM") {
            QualType::Chem
        } else if m(t1, "AGE") {
            QualType::Age
        } else if m(t1, "TRACE") {
            QualType::Trace
        } else {
            q.chem_name = t1.to_string();
            if n >= 2 {
                q.chem_units = tok[2].clone();
            }
            QualType::Chem
        };
        if q.qualflag == QualType::Trace {
            if n < 2 {
                return Err(err(201, "QUALITY TRACE needs a node"));
            }
            set.trace_id = Some(tok[2].clone());
            q.chem_name = "%".into();
            q.chem_units = tok[2].clone();
        }
        if q.qualflag == QualType::Age {
            q.chem_name = "AGE".into();
            q.chem_units = "hrs".into();
        }
    } else if m(t0, "MAP") || m(t0, "VERI") {
    } else if m(t0, "UNBA") {
        if n < 1 {
            return Ok(true);
        }
        if m(&tok[1], "STOP") {
            hyd.extra_iter = -1;
        } else if m(&tok[1], "CONT") {
            hyd.extra_iter = if n >= 2 { atoi(&tok[2]) } else { 0 };
        } else {
            return Err(err(213, format!("illegal UNBALANCED option {}", tok[1])));
        }
    } else if m(t0, "PATT") {
        if n < 1 {
            return Ok(true);
        }
        set.def_pat_id = tok[1].clone();
    } else if m(t0, "DEMAND") {
        if n < 2 {
            return Ok(true);
        }
        if !m(&tok[1], "MODEL") {
            return Ok(false);
        }
        hyd.demand_model = if m(&tok[2], "DDA") {
            DemandModel::Dda
        } else if m(&tok[2], "PDA") {
            DemandModel::Pda
        } else {
            return Err(err(213, format!("illegal demand model {}", tok[2])));
        };
    } else if m(t0, "BACK") {
        if n < 2 {
            return Ok(true);
        }
        if !m(&tok[1], "ALLOW") {
            return Ok(false);
        }
        hyd.emit_back_flag = if m(&tok[2], "NO") {
            false
        } else if m(&tok[2], "YES") {
            true
        } else {
            return Err(err(213, format!("illegal backflow option {}", tok[2])));
        };
    } else {
        return Ok(false);
    }
    Ok(true)
}

/// C's `atoi`.
fn atoi(s: &str) -> i32 {
    let s = s.trim_start();
    let (sign, digits) = match s.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let v = digits
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .fold(0i32, |a, c| {
            a.saturating_mul(10).saturating_add(c as i32 - '0' as i32)
        });
    sign * v
}

fn option_value(
    pr: &mut Project,
    _set: &mut Settings,
    tok: &[String],
    n: usize,
) -> Result<(), SolverError> {
    let hyd = &mut pr.hyd;
    let t0 = tok[0].as_str();
    if m(t0, "SEGM") {
        return Ok(());
    }
    let nvalue = if m(t0, "SPEC")
        || m(t0, "EMIT")
        || m(t0, "DEMAND")
        || m(t0, "MINI")
        || m(t0, "REQ")
        || m(t0, "PRESSURE")
        || m(t0, "PREC")
    {
        2
    } else {
        1
    };
    if n < nvalue {
        return Ok(());
    }
    let y = getfloat(&tok[nvalue])
        .ok_or_else(|| err(202, format!("illegal number {}", tok[nvalue])))?;
    let bad = || err(213, format!("illegal value for option {t0}"));
    if m(t0, "TOLER") {
        if y < 0.0 {
            return Err(bad());
        }
        pr.qual.ctol = y;
        return Ok(());
    }
    if m(t0, "DIFF") {
        if y < 0.0 {
            return Err(bad());
        }
        pr.qual.diffus = y;
        return Ok(());
    }
    if m(t0, "DAMPLIMIT") {
        hyd.damp_limit = y;
        return Ok(());
    } else if m(t0, "FLOWCHANGE") {
        if y < 0.0 {
            return Err(bad());
        }
        hyd.flow_change_limit = y;
        return Ok(());
    } else if m(t0, "HEADERROR") {
        if y < 0.0 {
            return Err(bad());
        }
        hyd.head_error_limit = y;
        return Ok(());
    } else if m(t0, "MINI") {
        if y < 0.0 {
            return Err(bad());
        }
        if hyd.preq == MINPDIFF {
            hyd.preq = y + MINPDIFF;
        } else if hyd.preq - y < MINPDIFF {
            return Err(err(208, "minimum pressure too close to required pressure"));
        }
        hyd.pmin = y;
        return Ok(());
    } else if m(t0, "REQ") {
        if y < 0.0 {
            return Err(bad());
        }
        if y - hyd.pmin < MINPDIFF {
            return Err(err(208, "required pressure too close to minimum pressure"));
        }
        hyd.preq = y;
        return Ok(());
    } else if m(t0, "PRESSURE") {
        if y < 0.0 {
            return Err(bad());
        }
        hyd.pexp = y;
        return Ok(());
    }
    if y <= 0.0 {
        return Err(bad());
    }
    if m(t0, "VISC") {
        hyd.viscos = y;
    } else if m(t0, "SPEC") {
        hyd.sp_grav = y;
    } else if m(t0, "TRIAL") {
        hyd.max_iter = y as i32;
    } else if m(t0, "ACCU") {
        hyd.hacc = y.clamp(1.0e-5, 1.0e-1);
    } else if m(t0, "HTOL") {
        hyd.htol = y;
    } else if m(t0, "QTOL") {
        hyd.qtol = y;
    } else if m(t0, "RQTOL") {
        if y >= 1.0 {
            return Err(bad());
        }
        hyd.rqtol = y;
    } else if m(t0, "CHECKFREQ") {
        hyd.check_freq = y as i32;
    } else if m(t0, "MAXCHECK") {
        hyd.max_check = y as i32;
    } else if m(t0, "EMIT") {
        hyd.qexp = 1.0 / y;
    } else if m(t0, "DEMAND") {
        hyd.dmult = y;
    } else {
        return Err(err(201, format!("unknown option {t0}")));
    }
    Ok(())
}

/// `timedata` (input3.c).
fn times(t: &mut Times, section: &KeywordSection) -> Result<(), SolverError> {
    for line in &section.lines {
        let tok = &line.tokens;
        if tok.len() < 2 {
            return Err(err(201, "too few items in [TIMES]"));
        }
        let n = tok.len() - 1;
        if m(&tok[0], "STAT") {
            continue; // reporting statistic: not used by the solver
        }
        let y = match getfloat(&tok[n]) {
            Some(v) => v,
            None => {
                let mut y = hour(&tok[n], "");
                if y < 0.0 {
                    y = hour(&tok[n - 1], &tok[n]);
                    if y < 0.0 {
                        return Err(err(213, format!("illegal time {}", tok[n])));
                    }
                }
                y
            }
        };
        let v = (3600.0 * y + 0.5) as i64;
        let t0 = tok[0].as_str();
        if m(t0, "DURA") {
            t.dur = v;
        } else if m(t0, "HYDR") {
            t.hstep = v;
        } else if m(t0, "QUAL") {
            t.qstep = v;
        } else if m(t0, "RULE") {
            t.rulestep = v;
        } else if m(t0, "MINI") {
        } else if m(t0, "PATT") {
            if m(&tok[1], "TIME") {
                t.pstep = v;
            } else if m(&tok[1], "STAR") {
                t.pstart = v;
            } else {
                return Err(err(213, "illegal PATTERN time keyword"));
            }
        } else if m(t0, "REPO") {
            if m(&tok[1], "TIME") {
                t.rstep = v;
            } else if m(&tok[1], "STAR") {
                t.rstart = v;
            } else {
                return Err(err(213, "illegal REPORT time keyword"));
            }
        } else if m(t0, "STAR") {
            t.tstart = v % SECPERDAY;
        } else {
            return Err(err(213, format!("unknown time option {t0}")));
        }
    }
    Ok(())
}

/// Build the project: read the model as EPANET's input stage would, then convert
/// to internal units and validate as `getdata` and `validateproject` do.
pub fn build(model: &Model) -> Result<Project, SolverError> {
    let mut pr = Project::default();
    let mut set = Settings::default();

    // Patterns: index 0 is EPANET's default pattern.
    let mut pattern_index = HashMap::new();
    pr.net.pattern.push(Pattern {
        id: String::new(),
        f: vec![1.0],
    });
    for p in &model.patterns {
        pattern_index.insert(p.id.as_str(), pr.net.pattern.len());
        pr.net.pattern.push(Pattern {
            id: p.id.clone(),
            f: p.multipliers.clone(),
        });
    }
    let mut curve_index = HashMap::new();
    pr.net.curve.push(Curve::default());
    for c in &model.curves {
        curve_index.insert(c.id.as_str(), pr.net.curve.len());
        pr.net.curve.push(Curve {
            id: c.id.clone(),
            x: c.points.iter().map(|p| p.0).collect(),
            y: c.points.iter().map(|p| p.1).collect(),
        });
    }
    let pat = |id: &Option<String>| -> Result<usize, SolverError> {
        match id {
            None => Ok(0),
            Some(id) => pattern_index
                .get(id.as_str())
                .copied()
                .ok_or_else(|| err(205, format!("undefined pattern {id}"))),
        }
    };
    let cur = |id: &str| -> Result<usize, SolverError> {
        curve_index
            .get(id)
            .copied()
            .ok_or_else(|| err(206, format!("undefined curve {id}")))
    };

    let source = |s: &Option<ws_model::Source>| -> Result<Option<Source>, SolverError> {
        Ok(match s {
            None => None,
            Some(s) => Some(Source {
                kind: match s.kind {
                    SourceKind::Concen => SourceType::Concen,
                    SourceKind::Mass => SourceType::Mass,
                    SourceKind::Setpoint => SourceType::Setpoint,
                    SourceKind::FlowPaced => SourceType::FlowPaced,
                },
                c0: s.strength,
                pat: pat(&s.pattern)?,
                smass: 0.0,
            }),
        })
    };

    options(&mut pr, &mut set, &model.options)?;
    times(&mut pr.times, &model.times)?;

    // Global energy settings (energydata).
    for line in &model.energy.lines {
        let t = &line.tokens;
        let n = t.len();
        if n < 3 {
            continue;
        }
        if m(&t[0], "DEMAN") {
            if let Some(y) = getfloat(&t[2]) {
                pr.hyd.dcost = y;
            }
        } else if m(&t[0], "GLOB") {
            let (key, val) = (&t[n - 2], &t[n - 1]);
            if m(key, "PRICE") {
                pr.hyd.ecost = getfloat(val).unwrap_or(0.0);
            } else if m(key, "PATT") {
                pr.hyd.epat = pat(&Some(val.clone()))?;
            } else if m(key, "EFFI") {
                pr.hyd.epump = getfloat(val).unwrap_or(75.0);
            }
        }
    }
    // Global reaction settings (reactdata). Per-pipe and per-tank coefficients are
    // already on the elements.
    for line in &model.reactions.lines {
        let t = &line.tokens;
        let n = t.len();
        if n < 3 {
            continue;
        }
        let num =
            || getfloat(&t[n - 1]).ok_or_else(|| err(202, format!("illegal number {}", t[n - 1])));
        let q = &mut pr.qual;
        if m(&t[0], "ORDER") {
            let y = num()?;
            if m(&t[1], "BULK") {
                q.bulk_order = y;
            } else if m(&t[1], "TANK") {
                q.tank_order = y;
            } else if m(&t[1], "WALL") {
                if y == 0.0 || y == 1.0 {
                    q.wall_order = y;
                } else {
                    return Err(err(
                        213,
                        format!("illegal wall reaction order {}", t[n - 1]),
                    ));
                }
            } else {
                return Err(err(213, format!("illegal reaction order keyword {}", t[1])));
            }
        } else if m(&t[0], "ROUG") {
            q.rfactor = num()?;
        } else if m(&t[0], "LIMIT") {
            q.climit = num()?;
        } else if m(&t[0], "GLOB") {
            let y = num()?;
            if m(&t[1], "BULK") {
                q.kbulk = y;
            } else if m(&t[1], "WALL") {
                q.kwall = y;
            } else {
                return Err(err(
                    213,
                    format!("illegal GLOBAL reaction keyword {}", t[1]),
                ));
            }
        }
    }

    // Nodes: junctions first, then tanks and reservoirs, each in file order.
    let mut node_index: HashMap<&str, usize> = HashMap::new();
    pr.net.node.push(Node {
        id: String::new(),
        el: 0.0,
        d: Vec::new(),
        c0: 0.0,
        ke: 0.0,
        node_type: NodeType::Junction,
        source: None,
    });
    pr.net.tank.push(Tank::default());
    pr.node_order.push(usize::MAX);
    for (mi, n) in model.nodes.iter().enumerate() {
        if let NodeKind::Junction(j) = &n.kind {
            pr.node_order.push(mi);
            let mut d = Vec::new();
            for dm in &j.demands {
                d.push(Demand {
                    base: dm.base,
                    pat: pat(&dm.pattern)?,
                });
            }
            node_index.insert(n.id.as_str(), pr.net.node.len());
            pr.net.node.push(Node {
                id: n.id.clone(),
                el: j.elevation,
                d,
                c0: n.initial_quality.unwrap_or(0.0),
                ke: j.emitter.unwrap_or(0.0),
                node_type: NodeType::Junction,
                source: source(&n.source)?,
            });
        }
    }
    pr.net.njuncs = pr.net.node.len() - 1;
    for (mi, n) in model.nodes.iter().enumerate() {
        let (el, tank, node_type) = match &n.kind {
            NodeKind::Junction(_) => continue,
            NodeKind::Reservoir(r) => (
                r.head,
                Tank {
                    h0: r.level,
                    pat: pat(&r.pattern)?,
                    kb: MISSING,
                    v1frac: 1.0,
                    ..Tank::default()
                },
                NodeType::Reservoir,
            ),
            NodeKind::Tank(t) => {
                // tankdata (input3.c), in user units
                let area = PI * (t.diameter * t.diameter) / 4.0;
                let mut vmin = area * t.min_level;
                if t.min_volume > 0.0 {
                    vmin = t.min_volume;
                }
                (
                    t.elevation,
                    Tank {
                        a: t.diameter,
                        h0: t.init_level,
                        hmin: t.min_level,
                        hmax: t.max_level,
                        vmin,
                        v0: vmin + area * (t.init_level - t.min_level),
                        vmax: vmin + area * (t.max_level - t.min_level),
                        kb: t.bulk_coeff.unwrap_or(MISSING),
                        vcurve: match &t.volume_curve {
                            Some(c) => cur(c)?,
                            None => 0,
                        },
                        can_overflow: t.overflow == Some(true),
                        // mixingdata: a zero fraction means 1, and only 2COMP uses it.
                        mix_model: match t.mixing.as_ref().map(|x| x.model) {
                            None | Some(ModelMix::Mixed) => MixModel::Mix1,
                            Some(ModelMix::TwoComp) => MixModel::Mix2,
                            Some(ModelMix::Fifo) => MixModel::Fifo,
                            Some(ModelMix::Lifo) => MixModel::Lifo,
                        },
                        v1frac: match &t.mixing {
                            Some(x) if x.model == ModelMix::TwoComp && x.fraction != 0.0 => {
                                x.fraction
                            }
                            _ => 1.0,
                        },
                        ..Tank::default()
                    },
                    NodeType::Tank,
                )
            }
        };
        let i = pr.net.node.len();
        pr.node_order.push(mi);
        node_index.insert(n.id.as_str(), i);
        pr.net.node.push(Node {
            id: n.id.clone(),
            el,
            d: Vec::new(),
            c0: n.initial_quality.unwrap_or(0.0),
            ke: 0.0,
            node_type,
            source: source(&n.source)?,
        });
        pr.net.tank.push(Tank { node: i, ..tank });
    }
    pr.net.nnodes = pr.net.node.len() - 1;
    pr.net.ntanks = pr.net.tank.len() - 1;
    if let Some(id) = &set.trace_id {
        pr.qual.trace_node = *node_index
            .get(id.as_str())
            .ok_or_else(|| err(212, format!("undefined trace node {id}")))?;
    }

    // Links in file order.
    let mut link_index: HashMap<&str, usize> = HashMap::new();
    pr.net.link.push(Link {
        id: String::new(),
        n1: 0,
        n2: 0,
        diam: 0.0,
        len: 0.0,
        kc: 0.0,
        km: 0.0,
        kb: 0.0,
        kw: 0.0,
        r: 0.0,
        leak_area: 0.0,
        leak_expan: 0.0,
        link_type: LinkType::Pipe,
        init_status: Status::Open,
        init_setting: 0.0,
        rc: 0.0,
    });
    pr.net.pump.push(Pump {
        link: 0,
        ptype: PumpType::NoCurve,
        q0: 0.0,
        qmax: 0.0,
        hmax: 0.0,
        h0: 0.0,
        r: 0.0,
        n: 0.0,
        hcurve: 0,
        ecurve: 0,
        upat: 0,
        epat: 0,
        ecost: 0.0,
        energy: Energy::default(),
    });
    pr.net.valve.push(Valve::default());
    for l in &model.links {
        let n1 = *node_index
            .get(l.from.as_str())
            .ok_or_else(|| err(203, format!("undefined node {}", l.from)))?;
        let n2 = *node_index
            .get(l.to.as_str())
            .ok_or_else(|| err(203, format!("undefined node {}", l.to)))?;
        let k = pr.net.link.len();
        let mut link = Link {
            id: l.id.clone(),
            n1,
            n2,
            diam: 0.0,
            len: 0.0,
            kc: 0.0,
            km: 0.0,
            kb: 0.0,
            kw: 0.0,
            r: 0.0,
            leak_area: 0.0,
            leak_expan: 0.0,
            link_type: LinkType::Pipe,
            init_status: Status::Open,
            init_setting: 0.0,
            rc: 0.0,
        };
        match &l.kind {
            LinkKind::Pipe(p) => {
                link.len = p.length;
                link.diam = p.diameter;
                link.kc = p.roughness;
                link.km = p.minor_loss;
                link.kb = p.bulk_coeff.unwrap_or(MISSING);
                link.kw = p.wall_coeff.unwrap_or(MISSING);
                if let Some((a, e)) = p.leakage {
                    link.leak_area = a;
                    link.leak_expan = e;
                }
                match p.status {
                    PipeStatus::CheckValve => link.link_type = LinkType::CvPipe,
                    PipeStatus::Closed => link.init_status = Status::Closed,
                    PipeStatus::Open => {}
                }
            }
            LinkKind::Pump(p) => {
                link.link_type = LinkType::Pump;
                link.kc = p.speed;
                link.init_status = match p.status {
                    OpenClosed::Open => Status::Open,
                    OpenClosed::Closed => Status::Closed,
                };
                let mut pump = Pump {
                    link: k,
                    ptype: PumpType::NoCurve,
                    q0: 0.0,
                    qmax: 0.0,
                    hmax: 0.0,
                    h0: 0.0,
                    r: 0.0,
                    n: 0.0,
                    hcurve: 0,
                    ecurve: 0,
                    upat: pat(&p.pattern)?,
                    epat: pat(&p.price_pattern)?,
                    ecost: p.price.unwrap_or(0.0),
                    energy: Energy::default(),
                };
                match &p.curve {
                    Some(PumpCurve::Power(w)) => {
                        pump.ptype = PumpType::ConstHp;
                        link.km = *w;
                    }
                    Some(PumpCurve::Head(c)) => {
                        pump.ptype = PumpType::Custom;
                        pump.hcurve = cur(c)?;
                    }
                    None => {}
                }
                if let Some(c) = &p.efficiency_curve {
                    pump.ecurve = cur(c)?;
                }
                pr.net.pump.push(pump);
            }
            LinkKind::Valve(v) => {
                link.link_type = match v.valve_type {
                    ValveType::Prv => LinkType::Prv,
                    ValveType::Psv => LinkType::Psv,
                    ValveType::Pbv => LinkType::Pbv,
                    ValveType::Fcv => LinkType::Fcv,
                    ValveType::Tcv => LinkType::Tcv,
                    ValveType::Gpv => LinkType::Gpv,
                    ValveType::Pcv => LinkType::Pcv,
                };
                link.diam = v.diameter;
                link.km = v.minor_loss;
                link.init_status = Status::Active;
                let mut valve = Valve { link: k, curve: 0 };
                match &v.setting {
                    ValveSetting::Curve(c) => {
                        link.kc = cur(c)? as f64;
                        link.init_status = Status::Open;
                    }
                    ValveSetting::Value(x) => link.kc = *x,
                }
                if let Some(c) = &v.pcv_curve {
                    valve.curve = cur(c)?;
                    if link.kc > 100.0 {
                        link.kc = 100.0;
                    }
                }
                match v.fixed_status {
                    Some(OpenClosed::Open) => link.init_status = Status::Open,
                    Some(OpenClosed::Closed) => link.init_status = Status::Closed,
                    None => {}
                }
                pr.net.valve.push(valve);
            }
        }
        link.init_setting = link.kc;
        link_index.insert(l.id.as_str(), k);
        pr.net.link.push(link);
    }
    pr.net.nlinks = pr.net.link.len() - 1;
    pr.net.npumps = pr.net.pump.len() - 1;
    pr.net.nvalves = pr.net.valve.len() - 1;

    // Simple controls (controldata).
    pr.net.control.push(Control {
        link: 0,
        node: 0,
        time: 0,
        grade: 0.0,
        setting: 0.0,
        status: Status::Active,
        control_type: ControlType::Timer,
        is_enabled: false,
    });
    for c in &model.controls {
        let control = parse_control(&pr.net, &c.tokens, &node_index, &link_index)?;
        pr.net.control.push(control);
    }
    pr.net.ncontrols = pr.net.control.len() - 1;
    pr.rules = crate::rules::parse_rules(&pr.net, &model.rules, &node_index, &link_index)?;

    adjustdata(&mut pr, &set, &pattern_index);
    inittanks(&mut pr);
    initunits(&mut pr);
    convertunits(&mut pr);
    validateproject(&mut pr)?;
    Ok(pr)
}

/// `controldata` (input3.c).
fn parse_control(
    net: &Network,
    tok: &[String],
    nodes: &HashMap<&str, usize>,
    links: &HashMap<&str, usize>,
) -> Result<Control, SolverError> {
    let mut n = tok.len();
    if n < 6 {
        return Err(err(201, "too few items in control"));
    }
    let mut is_enabled = true;
    if m(&tok[n - 1], "DISABLED") {
        is_enabled = false;
        n -= 1;
    }
    let k = *links
        .get(tok[1].as_str())
        .ok_or_else(|| err(204, format!("undefined link {}", tok[1])))?;
    let linktype = net.link[k].link_type;
    if linktype == LinkType::CvPipe {
        return Err(err(207, "attempt to control a check valve"));
    }
    let mut setting = MISSING;
    let mut status = Status::Active;
    if m(&tok[2], "OPEN") {
        status = Status::Open;
        if linktype == LinkType::Pump {
            setting = 1.0;
        }
        if linktype == LinkType::Gpv {
            setting = net.link[k].kc;
        }
    } else if m(&tok[2], "CLOSED") {
        status = Status::Closed;
        if linktype == LinkType::Pump {
            setting = 0.0;
        }
        if linktype == LinkType::Gpv {
            setting = net.link[k].kc;
        }
    } else if linktype == LinkType::Gpv {
        return Err(err(207, "illegal GPV control setting"));
    } else {
        setting =
            getfloat(&tok[2]).ok_or_else(|| err(202, format!("illegal setting {}", tok[2])))?;
    }
    if (linktype == LinkType::Pump || linktype == LinkType::Pipe) && setting != MISSING {
        if setting < 0.0 {
            return Err(err(211, "negative control setting"));
        } else if setting == 0.0 {
            status = Status::Closed;
        } else {
            status = Status::Open;
        }
    }
    let mut node = 0;
    let control_type = if m(&tok[4], "TIME") {
        ControlType::Timer
    } else if m(&tok[4], "CLOCKTIME") {
        ControlType::TimeOfDay
    } else {
        if n < 8 {
            return Err(err(201, "too few items in control"));
        }
        node = *nodes
            .get(tok[5].as_str())
            .ok_or_else(|| err(203, format!("undefined node {}", tok[5])))?;
        if m(&tok[6], "BELOW") {
            ControlType::LowLevel
        } else if m(&tok[6], "ABOVE") {
            ControlType::HiLevel
        } else {
            return Err(err(213, format!("illegal control keyword {}", tok[6])));
        }
    };
    let mut time = 0.0;
    let mut level = 0.0;
    match control_type {
        ControlType::Timer | ControlType::TimeOfDay => {
            if n == 6 {
                time = hour(&tok[5], "");
            }
            if n >= 7 {
                time = hour(&tok[5], &tok[6]);
            }
            if time < 0.0 {
                return Err(err(213, format!("illegal control time {}", tok[5])));
            }
        }
        ControlType::LowLevel | ControlType::HiLevel => {
            level = getfloat(&tok[7])
                .ok_or_else(|| err(202, format!("illegal control level {}", tok[7])))?;
        }
    }
    let mut t = (3600.0 * time) as i64;
    if control_type == ControlType::TimeOfDay {
        t %= SECPERDAY;
    }
    Ok(Control {
        link: k,
        node,
        time: t,
        grade: level,
        setting,
        status,
        control_type,
        is_enabled,
    })
}

/// `adjustdata` (input1.c).
fn adjustdata(pr: &mut Project, set_: &Settings, patterns: &HashMap<&str, usize>) {
    let t = &mut pr.times;
    if t.pstep <= 0 {
        t.pstep = 3600;
    }
    if t.rstep == 0 {
        t.rstep = t.pstep;
    }
    if t.hstep <= 0 {
        t.hstep = 3600;
    }
    if t.hstep > t.pstep {
        t.hstep = t.pstep;
    }
    if t.hstep > t.rstep {
        t.hstep = t.rstep;
    }
    if t.rstart > t.dur {
        t.rstart = 0;
    }
    if t.qstep == 0 {
        t.qstep = t.hstep / 10;
    }
    if t.rulestep == 0 {
        t.rulestep = t.hstep / 10;
    }
    t.rulestep = t.rulestep.min(t.hstep);
    t.qstep = t.qstep.min(t.hstep);
    let q = &mut pr.qual;
    if q.ctol == MISSING {
        q.ctol = if q.qualflag == QualType::Age {
            AGETOL
        } else {
            CHEMTOL
        };
    }

    let u = &mut pr.units;
    u.unitsflag = match u.flowflag {
        FlowUnits::Lps
        | FlowUnits::Lpm
        | FlowUnits::Mld
        | FlowUnits::Cmh
        | FlowUnits::Cmd
        | FlowUnits::Cms => UnitsType::Si,
        _ => UnitsType::Us,
    };
    if u.pressflag == PressUnits::Default {
        u.pressflag = if u.unitsflag == UnitsType::Si {
            PressUnits::Meters
        } else {
            PressUnits::Psi
        };
    }
    let ucf = if u.unitsflag == UnitsType::Si {
        M_PER_FT * M_PER_FT
    } else {
        1.0
    };
    let hyd = &mut pr.hyd;
    if hyd.viscos == MISSING {
        hyd.viscos = VISCOS;
    } else if hyd.viscos > 1.0e-3 {
        hyd.viscos *= VISCOS;
    } else {
        hyd.viscos /= ucf;
    }
    let q = &mut pr.qual;
    if q.diffus == MISSING {
        q.diffus = DIFFUS;
    } else if q.diffus > 1.0e-4 {
        q.diffus *= DIFFUS;
    } else {
        q.diffus /= ucf;
    }
    hyd.hexp = if hyd.formflag == Formula::Hw {
        1.852
    } else {
        2.0
    };

    let formflag = hyd.formflag;
    let set = &pr.qual;
    for link in pr.net.link.iter_mut().skip(1) {
        if link.link_type > LinkType::Pipe {
            continue;
        }
        if link.kb == MISSING {
            link.kb = set.kbulk;
        }
        if link.kw == MISSING {
            if set.rfactor == 0.0 {
                link.kw = set.kwall;
            } else if link.kc > 0.0 && link.diam > 0.0 {
                link.kw = match formflag {
                    Formula::Hw => set.rfactor / link.kc,
                    Formula::Dw => set.rfactor / log(link.kc / link.diam).abs(),
                    Formula::Cm => set.rfactor * link.kc,
                };
            } else {
                link.kw = 0.0;
            }
        }
    }
    for tank in pr.net.tank.iter_mut().skip(1) {
        if tank.kb == MISSING {
            tank.kb = set.kbulk;
        }
    }
    if let Some(&i) = patterns.get(set_.def_pat_id.as_str())
        && i > 0
    {
        pr.hyd.def_pat = i;
    }
}

/// `interp` (project.c).
pub fn interp(x: &[f64], y: &[f64], xx: f64) -> f64 {
    let n = x.len();
    if n == 0 {
        return 0.0;
    }
    let mm = n - 1;
    if xx <= x[0] {
        return y[0];
    }
    for k in 1..=mm {
        if x[k] >= xx {
            let dx = x[k] - x[k - 1];
            let dy = y[k] - y[k - 1];
            if dx.abs() < TINY {
                return y[k];
            }
            return y[k] - (x[k] - xx) * dy / dx;
        }
    }
    y[mm]
}

/// `inittanks` (input1.c).
fn inittanks(pr: &mut Project) {
    for j in 1..=pr.net.ntanks {
        let tank = &mut pr.net.tank[j];
        if tank.a == 0.0 {
            continue;
        }
        let i = tank.vcurve;
        if i > 0 {
            let curve = &pr.net.curve[i];
            let n = curve.x.len().saturating_sub(1);
            tank.vmin = interp(&curve.x, &curve.y, tank.hmin);
            tank.vmax = interp(&curve.x, &curve.y, tank.hmax);
            tank.v0 = interp(&curve.x, &curve.y, tank.h0);
            if let (Some(xn), Some(x0), Some(yn), Some(y0)) = (
                curve.x.get(n),
                curve.x.first(),
                curve.y.get(n),
                curve.y.first(),
            ) {
                let a = (yn - y0) / (xn - x0);
                tank.a = sqrt(4.0 * a / PI);
            }
        }
    }
}

/// `initunits` (input1.c): unit conversion factors.
fn initunits(pr: &mut Project) {
    let u = &mut pr.units;
    let (dcf, mut qcf, hcf, wcf);
    if u.unitsflag == UnitsType::Si {
        dcf = 1000.0 * M_PER_FT;
        qcf = match u.flowflag {
            FlowUnits::Lpm => LPM_PER_CFS,
            FlowUnits::Mld => MLD_PER_CFS,
            FlowUnits::Cmh => CMH_PER_CFS,
            FlowUnits::Cmd => CMD_PER_CFS,
            FlowUnits::Cms => CMS_PER_CFS,
            _ => LPS_PER_CFS,
        };
        hcf = M_PER_FT;
        wcf = KW_PER_HP;
    } else {
        dcf = 12.0;
        qcf = 1.0;
        match u.flowflag {
            FlowUnits::Gpm => qcf = GPM_PER_CFS,
            FlowUnits::Mgd => qcf = MGD_PER_CFS,
            FlowUnits::Imgd => qcf = IMGD_PER_CFS,
            FlowUnits::Afd => qcf = AFD_PER_CFS,
            _ => {}
        }
        hcf = 1.0;
        wcf = 1.0;
    }
    let sg = pr.hyd.sp_grav;
    let pcf = match u.pressflag {
        PressUnits::Meters => M_PER_FT,
        PressUnits::Kpa => KPA_PER_PSI * PSI_PER_FT * sg,
        PressUnits::Bar => BAR_PER_PSI * PSI_PER_FT * sg,
        PressUnits::Feet => 1.0,
        _ => PSI_PER_FT * sg,
    };
    let ccf = if pr.qual.qualflag == QualType::Chem {
        1.0 / L_PER_FT3
    } else {
        1.0
    };
    let f = &mut u.ucf;
    f[Field::Demand as usize] = qcf;
    f[Field::Elev as usize] = hcf;
    f[Field::Head as usize] = hcf;
    f[Field::Pressure as usize] = pcf;
    f[Field::Quality as usize] = ccf;
    f[Field::Length as usize] = hcf;
    f[Field::Diam as usize] = dcf;
    f[Field::Flow as usize] = qcf;
    f[Field::Velocity as usize] = hcf;
    f[Field::Headloss as usize] = hcf;
    f[Field::LinkQual as usize] = ccf;
    f[Field::ReactRate as usize] = ccf;
    f[Field::Friction as usize] = 1.0;
    f[Field::Power as usize] = wcf;
    f[Field::Volume as usize] = hcf * hcf * hcf;
    f[Field::Time as usize] = if pr.times.hstep < 1800 {
        1.0 / 60.0
    } else {
        1.0 / 3600.0
    };
}

/// `convertunits` (input1.c): from user units to EPANET's internal (US) units.
fn convertunits(pr: &mut Project) {
    let ucf = pr.units.ucf;
    let u = |f: Field| ucf[f as usize];
    let net = &mut pr.net;
    let hyd = &mut pr.hyd;
    for node in net.node.iter_mut().skip(1) {
        node.el /= u(Field::Elev);
        node.c0 /= u(Field::Quality);
    }
    for node in net.node.iter_mut().skip(1).take(net.njuncs) {
        for d in &mut node.d {
            d.base /= u(Field::Demand);
        }
    }
    hyd.pmin /= u(Field::Pressure);
    hyd.preq /= u(Field::Pressure);
    let ecf = if pr.units.unitsflag == UnitsType::Us {
        PSI_PER_FT * hyd.sp_grav
    } else {
        M_PER_FT
    };
    let qucf = pow(u(Field::Flow), hyd.qexp) / ecf;
    for node in net.node.iter_mut().skip(1).take(net.njuncs) {
        if node.ke > 0.0 {
            node.ke = qucf / pow(node.ke, hyd.qexp);
        }
    }
    for j in 1..=net.ntanks {
        let (el, c0) = (net.node[net.tank[j].node].el, net.node[net.tank[j].node].c0);
        let tank = &mut net.tank[j];
        tank.h0 = el + tank.h0 / u(Field::Elev);
        tank.hmin = el + tank.hmin / u(Field::Elev);
        tank.hmax = el + tank.hmax / u(Field::Elev);
        let a = tank.a / u(Field::Elev);
        tank.a = PI * (a * a) / 4.0;
        tank.v0 /= u(Field::Volume);
        tank.vmin /= u(Field::Volume);
        tank.vmax /= u(Field::Volume);
        tank.kb /= SECPERDAY as f64;
        tank.v = tank.v0;
        tank.c = c0;
    }
    hyd.flow_change_limit /= u(Field::Flow);
    hyd.head_error_limit /= u(Field::Head);
    let q = &mut pr.qual;
    q.climit /= u(Field::Quality);
    q.ctol /= u(Field::Quality);
    q.kbulk /= SECPERDAY as f64;
    q.kwall /= SECPERDAY as f64;

    let formflag = hyd.formflag;
    for link in net.link.iter_mut().skip(1) {
        if link.link_type <= LinkType::Pipe {
            if formflag == Formula::Dw {
                link.kc /= 1000.0 * u(Field::Elev);
            }
            link.diam /= u(Field::Diam);
            link.len /= u(Field::Length);
            link.km = 0.02517 * link.km / (link.diam * link.diam) / (link.diam * link.diam);
            link.kb /= SECPERDAY as f64;
            link.kw /= SECPERDAY as f64;
            link.leak_area *= u(Field::Length);
            link.leak_expan *= u(Field::Length);
        } else if link.link_type == LinkType::Pump {
            link.km /= u(Field::Power);
        } else {
            link.diam /= u(Field::Diam);
            link.km = 0.02517 * link.km / (link.diam * link.diam) / (link.diam * link.diam);
            if link.kc != MISSING {
                match link.link_type {
                    LinkType::Fcv => link.kc /= u(Field::Flow),
                    LinkType::Prv | LinkType::Psv | LinkType::Pbv => link.kc /= u(Field::Pressure),
                    _ => {}
                }
            }
        }
        link.init_setting = link.kc;
    }
    for i in 1..=net.ncontrols {
        let k = net.control[i].link;
        if k == 0 {
            continue;
        }
        let ltype = net.link[k].link_type;
        let j = net.control[i].node;
        let control = &mut net.control[i];
        if j > 0 {
            let el = net.node[j].el;
            if j > net.njuncs {
                control.grade = el + control.grade / u(Field::Elev);
            } else {
                control.grade = el + control.grade / u(Field::Pressure);
            }
        }
        if control.setting != MISSING {
            match ltype {
                LinkType::Prv | LinkType::Psv | LinkType::Pbv => {
                    control.setting /= u(Field::Pressure)
                }
                LinkType::Fcv => control.setting /= u(Field::Flow),
                _ => {}
            }
        }
    }
}

/// `validateproject` (validate.c), including pump curve processing.
fn validateproject(pr: &mut Project) -> Result<(), SolverError> {
    if pr.net.nnodes < 2 {
        return Err(err(223, "not enough nodes in network"));
    }
    if pr.net.ntanks == 0 {
        return Err(err(224, "no tanks or reservoirs in network"));
    }
    let ucf = pr.units.ucf;
    // validatetanks
    for j in 1..=pr.net.ntanks {
        let tank = &pr.net.tank[j];
        if tank.a == 0.0 {
            continue;
        }
        let mut levelerr = tank.h0 > tank.hmax || tank.hmin > tank.hmax || tank.h0 < tank.hmin;
        let elev = pr.net.node[tank.node].el;
        if tank.vcurve > 0 {
            let curve = &pr.net.curve[tank.vcurve];
            if let (Some(x0), Some(xn)) = (curve.x.first(), curve.x.last())
                && ((tank.hmin - elev) * ucf[Field::Elev as usize] < x0 - TINY
                    || (tank.hmax - elev) * ucf[Field::Elev as usize] > xn + TINY)
            {
                levelerr = true;
            }
        }
        if levelerr {
            return Err(err(
                225,
                format!(
                    "invalid lower/upper levels for tank {}",
                    pr.net.node[tank.node].id
                ),
            ));
        }
    }
    // validatepumps
    for i in 1..=pr.net.npumps {
        let k = pr.net.pump[i].link;
        let hcurve = pr.net.pump[i].hcurve;
        let km = pr.net.link[k].km;
        let code = if hcurve > 0 {
            let curve = pr.net.curve[hcurve].clone();
            pumpcurvepump(&mut pr.net.pump[i], &curve, &ucf)
        } else if km > 0.0 {
            let pump = &mut pr.net.pump[i];
            pump.ptype = PumpType::ConstHp;
            pump.h0 = 0.0;
            pump.r = -8.814 * km / ucf[Field::Power as usize];
            pump.n = -1.0;
            pump.hmax = BIG;
            pump.qmax = BIG;
            pump.q0 = 1.0;
            0
        } else {
            pr.net.pump[i].ptype = PumpType::NoCurve;
            226
        };
        if code != 0 {
            return Err(err(
                code,
                format!("invalid curve for pump {}", pr.net.link[k].id),
            ));
        }
    }
    // validatepatterns
    for p in &pr.net.pattern {
        if p.f.is_empty() {
            return Err(err(232, format!("pattern {} has no multipliers", p.id)));
        }
    }
    // validatecurves
    for c in pr.net.curve.iter().skip(1) {
        if c.x.is_empty() {
            return Err(err(231, format!("curve {} has no points", c.id)));
        }
        if c.x.windows(2).any(|w| w[0] >= w[1]) {
            return Err(err(
                230,
                format!("curve {} has non-increasing X values", c.id),
            ));
        }
    }
    Ok(())
}

/// `powerfuncpump` (validate.c).
fn powerfuncpump(h0: f64, h1: f64, h2: f64, q1: f64, q2: f64) -> Option<(f64, f64, f64)> {
    if h0 < TINY || h0 - h1 < TINY || h1 - h2 < TINY || q1 < TINY || q2 - q1 < TINY {
        return None;
    }
    let a = h0;
    let h4 = h0 - h1;
    let h5 = h0 - h2;
    let c = log(h5 / h4) / log(q2 / q1);
    if c <= 0.0 || c > 20.0 {
        return None;
    }
    let b = -h4 / pow(q1, c);
    if b >= 0.0 {
        return None;
    }
    Some((a, b, c))
}

/// `pumpcurvepump` and `customcurvepump` (validate.c).
fn pumpcurvepump(pump: &mut Pump, curve: &Curve, ucf: &[f64; MAXVAR]) -> i32 {
    let uflow = ucf[Field::Flow as usize];
    let uhead = ucf[Field::Head as usize];
    let npts = curve.x.len();
    let (h0, h1, h2, q1, q2);
    if npts == 1 {
        pump.ptype = PumpType::PowerFunc;
        q1 = curve.x[0];
        h1 = curve.y[0];
        h0 = 1.33334 * h1;
        q2 = 2.0 * q1;
        h2 = 0.0;
    } else if npts == 3 && curve.x[0] == 0.0 {
        pump.ptype = PumpType::PowerFunc;
        h0 = curve.y[0];
        q1 = curve.x[1];
        h1 = curve.y[1];
        q2 = curve.x[2];
        h2 = curve.y[2];
    } else {
        // customcurvepump
        pump.ptype = PumpType::Custom;
        for mm in 1..npts {
            if curve.y[mm] >= curve.y[mm - 1] {
                pump.ptype = PumpType::NoCurve;
                return 227;
            }
        }
        pump.qmax = curve.x[npts - 1];
        pump.q0 = (curve.x[0] + pump.qmax) / 2.0 / uflow;
        pump.qmax /= uflow;
        pump.hmax = curve.y[0] / uhead;
        return 0;
    }
    match powerfuncpump(h0, h1, h2, q1, q2) {
        None => {
            pump.ptype = PumpType::NoCurve;
            227
        }
        Some((a, b, c)) => {
            pump.h0 = -a / uhead;
            pump.r = -b * (pow(uflow, c) / uhead);
            pump.n = c;
            pump.q0 = q1 / uflow;
            pump.qmax = pow(-a / b, 1.0 / c) / uflow;
            pump.hmax = h0 / uhead;
            0
        }
    }
}
