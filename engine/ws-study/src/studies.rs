//! Studies over many hydraulic solutions: fire flow at hydrants and the criticality of
//! links. Each item is independent, so callers can split the list across workers and
//! concatenate the results in order; the answer equals the sequential one.

use serde::{Deserialize, Serialize};
use ws_model::{LinkKind, Model, OpenClosed, PipeStatus};
use ws_solver::math::pow;
use ws_solver::{Hydraulics, hour};

/// Fire flow: a design flow drawn at each hydrant, at one time of day.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireFlowOptions {
    /// Junction IDs.
    pub hydrants: Vec<String>,
    /// Design fire flow, in the model's flow units.
    pub flow: f64,
    /// Lowest acceptable pressure at the hydrant while it flows, in pressure units.
    pub residual: f64,
    /// Lowest acceptable pressure at every other junction, if checked.
    #[serde(default)]
    pub system_min: Option<f64>,
    /// Time into the demand patterns, in seconds (0: their start).
    #[serde(default)]
    pub time: i64,
    /// The largest flow searched for when finding the available flow (default 10 × design).
    #[serde(default)]
    pub max_flow: Option<f64>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FireFlowResult {
    pub id: String,
    /// Pressure at the hydrant with no fire flow.
    pub static_pressure: f64,
    /// Pressure at the hydrant while the design flow is drawn.
    pub residual_pressure: f64,
    /// Lowest pressure at any other junction while the design flow is drawn, and where.
    pub critical_pressure: f64,
    pub critical_node: Option<String>,
    /// The largest flow that keeps the residual (and system) pressure limits.
    pub available_flow: f64,
    /// Whether the design flow keeps the limits.
    pub meets: bool,
    pub error: Option<String>,
}

/// The model as a single-period analysis at a time of day.
pub(crate) fn at_time(model: &Model, time: i64) -> Model {
    let mut m = model.clone();
    let start = ws_model_pattern_start(&m);
    m.times.lines.retain(|l| {
        let t = l
            .tokens
            .first()
            .map(|t| t.to_ascii_uppercase())
            .unwrap_or_default();
        !(t.starts_with("DURA")
            || (t.starts_with("PATT")
                && l.tokens
                    .get(1)
                    .is_some_and(|x| x.to_ascii_uppercase().starts_with("STAR"))))
    });
    let push = |m: &mut Model, tokens: &[&str]| {
        m.times.lines.push(ws_model::KeywordLine {
            tokens: tokens.iter().map(|s| (*s).to_string()).collect(),
            comment: None,
        });
    };
    push(&mut m, &["DURATION", "0"]);
    let secs = start + time;
    let hhmm = format!("{}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60);
    push(&mut m, &["PATTERN", "START", &hhmm]);
    m
}

/// PATTERN START of a model in seconds, read as EPANET's `timedata` reads it (0 if absent).
fn ws_model_pattern_start(m: &Model) -> i64 {
    for l in m.times.lines.iter().rev() {
        let t = &l.tokens;
        if t.len() >= 3
            && t[0].to_ascii_uppercase().starts_with("PATT")
            && t[1].to_ascii_uppercase().starts_with("STAR")
        {
            let n = t.len() - 1;
            let y = match t[n].parse::<f64>() {
                Ok(v) => v,
                Err(_) => {
                    let y = hour(&t[n], "");
                    if y >= 0.0 { y } else { hour(&t[n - 1], &t[n]) }
                }
            };
            if y >= 0.0 {
                return (3600.0 * y + 0.5) as i64;
            }
        }
    }
    0
}

/// Pressures with an extra demand at a junction, or None if the network cannot be solved.
fn solve_with(base: &Hydraulics, node: usize, flow: f64) -> Option<Vec<f64>> {
    let mut h = base.clone();
    if flow > 0.0 {
        h.add_constant_demand(node, flow).ok()?;
    }
    h.run().ok()?;
    Some(h.pressures())
}

pub fn fire_flow(model: &Model, opts: &FireFlowOptions) -> Result<Vec<FireFlowResult>, String> {
    let m = at_time(model, opts.time);
    let mut base = Hydraulics::new(&m).map_err(|e| e.to_string())?;
    // Solve once: every hydrant's solves then start from this solution.
    base.run().map_err(|e| e.to_string())?;
    let ids: Vec<String> = base.node_ids().map(str::to_string).collect();
    let njuncs = base.junction_count();
    let static_p =
        solve_with(&base, 0, 0.0).ok_or("the network cannot be solved without fire flow")?;
    let max_flow = opts.max_flow.unwrap_or(opts.flow * 10.0).max(opts.flow);
    let mut out = Vec::with_capacity(opts.hydrants.len());
    let mut h = base.clone();
    let mut previous: Option<usize> = None;
    for id in &opts.hydrants {
        let Some(node) = ids.iter().position(|x| x == id).filter(|&i| i < njuncs) else {
            out.push(FireFlowResult {
                id: id.clone(),
                static_pressure: f64::NAN,
                residual_pressure: f64::NAN,
                critical_pressure: f64::NAN,
                critical_node: None,
                available_flow: 0.0,
                meets: false,
                error: Some(format!("{id} is not a junction")),
            });
            continue;
        };
        // How far a flow stays inside the limits: >= 0 means it keeps them.
        let margin = |p: &[f64]| -> (f64, f64, Option<usize>) {
            let mut low = f64::INFINITY;
            let mut at = None;
            for (i, &v) in p.iter().enumerate().take(njuncs) {
                if i != node && v < low {
                    low = v;
                    at = Some(i);
                }
            }
            let mut m = p[node] - opts.residual;
            if let Some(s) = opts.system_min {
                m = m.min(low - s);
            }
            (m, low, at)
        };
        // One solution, re-solved from flow to flow: each hydrant starts from the static
        // solution, each later flow from the last (fewer trials than starting afresh).
        if let Some(prev) = previous.replace(node) {
            h.set_constant_demand(prev, 0.0)
                .map_err(|e| e.to_string())?;
        }
        h.copy_solution(&base);
        let mut solve = |q: f64| -> Option<Vec<f64>> {
            h.set_constant_demand(node, q).ok()?;
            h.run().ok()?;
            Some(h.pressures())
        };
        let design = solve(opts.flow);
        let (residual, critical, critical_node, meets) = match &design {
            Some(p) => {
                let (m, low, at) = margin(p);
                (p[node], low, at.map(|i| ids[i].clone()), m >= 0.0)
            }
            None => (f64::NAN, f64::NAN, None, false),
        };
        let mut probe = |q: f64| -> Option<f64> { solve(q).map(|p| margin(&p).0) };
        let static_margin = margin(&static_p).0;
        let design_margin = design.as_ref().map(|p| margin(p).0);
        let available = available_flow(
            static_margin,
            opts.flow,
            design_margin,
            max_flow,
            &mut probe,
        );
        out.push(FireFlowResult {
            id: id.clone(),
            static_pressure: static_p[node],
            residual_pressure: residual,
            critical_pressure: critical,
            critical_node,
            available_flow: available,
            meets,
            error: if design.is_none() {
                Some("the network cannot be solved with the design flow".into())
            } else {
                None
            },
        });
    }
    Ok(out)
}

/// Relative width of the flow interval the available flow is found to.
const FLOW_TOLERANCE: f64 = 2e-3;

/// The largest flow (up to `max_flow`) whose margin `probe` finds non-negative, to
/// within [`FLOW_TOLERANCE`]. After the design flow, the largest flow is tried; if it
/// breaks the limits, the root is bracketed and found by regula falsi in x = q^1.852
/// (pressure falls with about the 1.852nd power of the flow drawn, as hydrant flow tests
/// assume, so the margin is close to linear in x), probing just below and just above
/// each estimate, which usually closes the bracket in one round. A probe that fails to
/// solve counts as breaking the limits.
fn available_flow(
    static_margin: f64,
    design: f64,
    design_margin: Option<f64>,
    max_flow: f64,
    probe: &mut dyn FnMut(f64) -> Option<f64>,
) -> f64 {
    const EXP: f64 = 1.852;
    if static_margin < 0.0 {
        return 0.0;
    }
    // The engine's own pow, so results are the same natively and in WebAssembly.
    let x = |q: f64| pow(q, EXP);
    let q_of = |x: f64| pow(x.max(0.0), 1.0 / EXP);
    // The largest flow known to keep the limits, and the smallest known to break them
    // (a failed solve breaks them with an unknown margin).
    let mut lo = (0.0, static_margin);
    let mut hi: Option<(f64, f64)> = None;
    let seen = |q: f64, m: Option<f64>, lo: &mut (f64, f64), hi: &mut Option<(f64, f64)>| match m {
        Some(m) if m >= 0.0 => {
            if q > lo.0 {
                *lo = (q, m);
            }
        }
        _ => {
            if hi.is_none_or(|(hq, _)| q < hq) {
                *hi = Some((q, m.unwrap_or(f64::NEG_INFINITY)));
            }
        }
    };
    seen(design, design_margin, &mut lo, &mut hi);
    if hi.is_none() {
        let m = probe(max_flow);
        seen(max_flow, m, &mut lo, &mut hi);
    }
    let Some(mut bracket) = hi else {
        return max_flow;
    };
    // Illinois: an end kept twice in a row counts for half, so the estimate moves on.
    let mut kept_lo = 0;
    let mut kept_hi = 0;
    for _ in 0..16 {
        let (hq, hm) = bracket;
        if hq - lo.0 <= FLOW_TOLERANCE * hq.max(1.0) {
            break;
        }
        let estimate = if hm.is_finite() && lo.1 - hm > 0.0 {
            let ml = if kept_lo >= 2 { 0.5 * lo.1 } else { lo.1 };
            let mh = if kept_hi >= 2 { 0.5 * hm } else { hm };
            let (xl, xh) = (x(lo.0), x(hq));
            q_of(xl + ml * (xh - xl) / (ml - mh))
        } else {
            0.5 * (lo.0 + hq)
        };
        let half = 0.5 * FLOW_TOLERANCE * estimate.max(1.0);
        let (before_lo, before_hi) = (lo.0, hq);
        let below = estimate - half;
        let above = estimate + half;
        if below > lo.0 && above < hq {
            let m = probe(below);
            seen(below, m, &mut lo, &mut hi);
            if m.is_some_and(|m| m >= 0.0) {
                let m = probe(above);
                seen(above, m, &mut lo, &mut hi);
            }
        } else {
            let mid = 0.5 * (lo.0 + hq);
            let m = probe(mid);
            seen(mid, m, &mut lo, &mut hi);
        }
        bracket = hi.unwrap_or(bracket);
        kept_lo = if lo.0 == before_lo { kept_lo + 1 } else { 0 };
        kept_hi = if bracket.0 == before_hi {
            kept_hi + 1
        } else {
            0
        };
    }
    lo.0
}

/// Criticality: each link taken out of service in turn over the whole simulation.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticalityOptions {
    /// Link IDs; empty means every pipe.
    #[serde(default)]
    pub links: Vec<String>,
    /// Pressure below which a junction counts as under-served, in pressure units.
    pub pressure: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CriticalityResult {
    pub id: String,
    /// Junctions below the pressure at some time, beyond those already below with every link in service.
    pub nodes_below: usize,
    /// Lowest junction pressure over the simulation, and where.
    pub min_pressure: f64,
    pub min_node: Option<String>,
    /// Demand not delivered (pressure-driven analysis), as volume over the simulation in flow units × hours.
    pub deficit: f64,
    /// The simulation failed or EPANET warned that the system is unbalanced or disconnected.
    pub failed: bool,
    pub error: Option<String>,
}

struct Outcome {
    below: Vec<bool>,
    min: f64,
    min_at: Option<usize>,
    deficit: f64,
}

fn simulate_outcome(model: &Model, pressure: f64) -> Result<Outcome, String> {
    let mut h = Hydraulics::new(model).map_err(|e| e.to_string())?;
    let n = h.junction_count();
    let mut o = Outcome {
        below: vec![false; n],
        min: f64::INFINITY,
        min_at: None,
        deficit: 0.0,
    };
    loop {
        h.run().map_err(|e| e.to_string())?;
        if matches!(h.warning(), 1 | 2) {
            return Err("the network is unbalanced without this link".into());
        }
        let p = h.pressures();
        for (i, &v) in p.iter().enumerate().take(n) {
            if v < pressure {
                o.below[i] = true;
            }
            if v < o.min {
                o.min = v;
                o.min_at = Some(i);
            }
        }
        let d: f64 = h
            .demand_deficits()
            .iter()
            .take(n)
            .filter(|v| **v > 0.0)
            .sum();
        let step = h.advance();
        o.deficit += d * step as f64 / 3600.0;
        if step <= 0 {
            break;
        }
    }
    Ok(o)
}

fn closed(model: &Model, id: &str) -> Option<Model> {
    let mut m = model.clone();
    let l = m.links.iter_mut().find(|l| l.id == id)?;
    match &mut l.kind {
        LinkKind::Pipe(p) => p.status = PipeStatus::Closed,
        LinkKind::Pump(p) => p.status = OpenClosed::Closed,
        LinkKind::Valve(v) => v.fixed_status = Some(OpenClosed::Closed),
    }
    Some(m)
}

pub fn criticality(
    model: &Model,
    opts: &CriticalityOptions,
) -> Result<Vec<CriticalityResult>, String> {
    let base = simulate_outcome(model, opts.pressure)?;
    let ids: Vec<String> = Hydraulics::new(model)
        .map_err(|e| e.to_string())?
        .node_ids()
        .map(str::to_string)
        .collect();
    let links: Vec<String> = if opts.links.is_empty() {
        model
            .links
            .iter()
            .filter(|l| matches!(l.kind, LinkKind::Pipe(_)))
            .map(|l| l.id.clone())
            .collect()
    } else {
        opts.links.clone()
    };
    let mut out = Vec::with_capacity(links.len());
    for id in links {
        let Some(m) = closed(model, &id) else {
            out.push(CriticalityResult {
                id: id.clone(),
                nodes_below: 0,
                min_pressure: f64::NAN,
                min_node: None,
                deficit: 0.0,
                failed: true,
                error: Some(format!("there is no link {id}")),
            });
            continue;
        };
        out.push(match simulate_outcome(&m, opts.pressure) {
            Ok(o) => CriticalityResult {
                id,
                nodes_below: o
                    .below
                    .iter()
                    .zip(&base.below)
                    .filter(|(a, b)| **a && !**b)
                    .count(),
                min_pressure: o.min,
                min_node: o.min_at.map(|i| ids[i].clone()),
                deficit: (o.deficit - base.deficit).max(0.0),
                failed: false,
                error: None,
            },
            Err(e) => CriticalityResult {
                id,
                nodes_below: 0,
                min_pressure: f64::NAN,
                min_node: None,
                deficit: 0.0,
                failed: true,
                error: Some(e),
            },
        });
    }
    Ok(out)
}
