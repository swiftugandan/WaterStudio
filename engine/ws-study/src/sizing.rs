//! Least-cost pipe sizing and fire-flow repair (ADR 0022): choose diameters for a set
//! of pipes from a list of standard sizes so that the network meets its limits at every
//! report time, and every hydrant given delivers its fire flow, at the least cost.
//!
//! The search is deterministic and explainable, the way an engineer sizes by hand:
//!
//! 1. **Enlarge.** While a limit is broken, try the next size up on each candidate pipe
//!    and keep the one that removes the most shortfall per unit of cost. Candidates are
//!    the pipes that break a velocity or head loss limit themselves and the pipes that
//!    lose the most head (where a larger size helps pressure most); if none of those
//!    helps, every pipe is tried before giving up.
//! 2. **Trim.** Once every limit is met, step pipes back down, largest saving first,
//!    while the limits stay met, so no pipe is larger than the design needs.
//!
//! Shortfall is the sum, over every breach at every report time (or fire flow), of how
//! far the value is past its limit relative to the limit. Values are compared as the
//! output file stores them (single precision), so a design this search accepts is one
//! the app's criteria check accepts too.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ws_model::{LinkKind, Model};
use ws_solver::Hydraulics;

use crate::studies::at_time;

/// A standard pipe size and what it costs to lay, per unit length.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PipeSize {
    /// In the model's diameter units (inches or millimetres).
    pub diameter: f64,
    /// Cost per unit length (foot or metre) in any currency.
    pub unit_cost: f64,
}

/// Limits checked at every report time of the simulation; unset limits are not checked.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default)]
    pub min_pressure: Option<f64>,
    #[serde(default)]
    pub max_pressure: Option<f64>,
    #[serde(default)]
    pub max_velocity: Option<f64>,
    /// Pipe head loss per 1000 length units.
    #[serde(default)]
    pub max_headloss: Option<f64>,
}

impl Limits {
    fn any(&self) -> bool {
        self.min_pressure.is_some()
            || self.max_pressure.is_some()
            || self.max_velocity.is_some()
            || self.max_headloss.is_some()
    }
}

/// Fire flows every hydrant must deliver, one at a time, at one time of day.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireDemand {
    /// Junction IDs.
    pub hydrants: Vec<String>,
    /// Design fire flow, in the model's flow units.
    pub flow: f64,
    /// Lowest acceptable pressure at the hydrant while it flows.
    pub residual: f64,
    /// Lowest acceptable pressure at every other junction meanwhile, if checked.
    #[serde(default)]
    pub system_min: Option<f64>,
    /// Time into the demand patterns, in seconds.
    #[serde(default)]
    pub time: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizingOptions {
    /// IDs of the pipes whose diameter may change.
    pub pipes: Vec<String>,
    /// The sizes available, with their costs.
    pub sizes: Vec<PipeSize>,
    #[serde(default)]
    pub limits: Limits,
    /// Fire flows to deliver (fire-flow repair).
    #[serde(default)]
    pub fire: Option<FireDemand>,
    /// Size the pipes as new: start every one at the smallest size and cost all of them.
    /// Otherwise a pipe keeps its diameter at no cost or is replaced by a larger size.
    #[serde(default)]
    pub from_smallest: bool,
    /// The most hydraulic solutions the search may run (default 5,000).
    #[serde(default)]
    pub max_solutions: Option<usize>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SizeChange {
    pub id: String,
    pub from: f64,
    pub to: f64,
    pub length: f64,
    /// What laying the new size costs.
    pub cost: f64,
}

/// A limit broken by one element: the worst value over every report time (or fire flow).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Breach {
    /// `minPressure`, `maxPressure`, `maxVelocity`, `maxHeadloss` (as the design criteria
    /// name them), `fireResidual` (at a hydrant) or `fireSystem` (elsewhere during a fire).
    pub kind: &'static str,
    pub id: String,
    pub value: f64,
    pub limit: f64,
    /// For fire limits: the hydrant flowing when it was worst.
    pub hydrant: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SizingResult {
    /// Pipes whose diameter the design changes.
    pub changes: Vec<SizeChange>,
    /// The design's cost: of the changed pipes, or of every candidate when sized as new.
    pub cost: f64,
    /// Whether every limit is met with the sizes found.
    pub meets: bool,
    /// Breaches as the network is, and with the sizes found: worst first, at most 20.
    pub before: Vec<Breach>,
    pub after: Vec<Breach>,
    pub breaches_before: usize,
    pub breaches_after: usize,
    /// Hydraulic evaluations the search ran (each an extended-period simulation, plus a
    /// solution per hydrant when fire flows are given).
    pub solutions: usize,
    /// Why the search stopped before meeting every limit.
    pub stopped: Option<String>,
}

const LISTED: usize = 20;
/// Pipes tried per enlargement step, besides those that break a limit themselves.
const RANKED: usize = 24;
const DEFAULT_SOLUTIONS: usize = 5_000;

struct Candidate {
    link: usize,
    id: String,
    length: f64,
    original: f64,
    /// Sizes it may take, smallest first: (diameter, unit cost, is its present diameter).
    ladder: Vec<(f64, f64, bool)>,
    pos: usize,
}

impl Candidate {
    fn cost_at(&self, pos: usize, as_new: bool) -> f64 {
        let (_, unit, original) = self.ladder[pos];
        if original && !as_new {
            0.0
        } else {
            self.length * unit
        }
    }
}

/// What one evaluation found.
#[derive(Clone)]
struct Eval {
    shortfall: f64,
    feasible: bool,
    breaches: BTreeMap<(&'static str, String), (Breach, f64)>,
    /// Per model link: the most head it loses at any report time or fire flow.
    relevance: Vec<f64>,
    error: Option<String>,
}

impl Eval {
    fn new(links: usize) -> Self {
        Eval {
            shortfall: 0.0,
            feasible: true,
            breaches: BTreeMap::new(),
            relevance: vec![0.0; links],
            error: None,
        }
    }

    fn failed(links: usize, error: String) -> Self {
        Eval {
            shortfall: f64::INFINITY,
            feasible: false,
            error: Some(error),
            ..Eval::new(links)
        }
    }

    /// Record `value` past `limit` (below it when `below`); no-op when within it.
    fn check(
        &mut self,
        kind: &'static str,
        id: &str,
        value: f64,
        limit: f64,
        below: bool,
        hydrant: Option<&str>,
    ) {
        let past = if below { limit - value } else { value - limit };
        if past <= 0.0 || value.is_nan() {
            return;
        }
        let amount = past / limit.abs().max(1.0);
        self.shortfall += amount;
        self.feasible = false;
        let key = (kind, id.to_string());
        if self.breaches.get(&key).is_none_or(|(_, a)| amount > *a) {
            let b = Breach {
                kind,
                id: id.to_string(),
                value,
                limit,
                hydrant: hydrant.map(str::to_string),
            };
            self.breaches.insert(key, (b, amount));
        }
    }

    fn listed(&self) -> Vec<Breach> {
        let mut v: Vec<&(Breach, f64)> = self.breaches.values().collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1));
        v.into_iter().take(LISTED).map(|(b, _)| b.clone()).collect()
    }
}

/// Round as the output file stores results, so limits are judged as the app judges them.
fn stored(v: f64) -> f64 {
    v as f32 as f64
}

struct Network {
    /// Per model link: its length if it is a pipe.
    pipe_length: Vec<Option<f64>>,
    link_ids: Vec<String>,
}

fn evaluate(m: &Model, net: &Network, opts: &SizingOptions) -> Eval {
    let mut e = Eval::new(m.links.len());
    if opts.limits.any()
        && let Err(err) = extended_period(m, net, &opts.limits, &mut e)
    {
        return Eval::failed(m.links.len(), err);
    }
    if let Some(f) = &opts.fire
        && let Err(err) = fire_flows(m, net, f, &mut e)
    {
        return Eval::failed(m.links.len(), err);
    }
    e
}

fn head_lost(net: &Network, hl: &[f64], e: &mut Eval) {
    for (i, len) in net.pipe_length.iter().enumerate() {
        if let (Some(len), Some(h)) = (len, hl.get(i)) {
            let lost = h.abs() * len / 1000.0;
            if lost > e.relevance[i] {
                e.relevance[i] = lost;
            }
        }
    }
}

fn extended_period(m: &Model, net: &Network, lim: &Limits, e: &mut Eval) -> Result<(), String> {
    let mut h = Hydraulics::new(m).map_err(|x| x.to_string())?;
    let (rstart, rstep, _) = h.report_times();
    let nj = h.junction_count();
    let ids: Vec<String> = h.node_ids().map(str::to_string).collect();
    loop {
        let t = h.run().map_err(|x| x.to_string())?;
        if matches!(h.warning(), 1 | 2) {
            return Err(format!(
                "the network is unbalanced at {}:{:02}",
                t / 3600,
                (t % 3600) / 60
            ));
        }
        if t >= rstart && (rstep <= 0 || (t - rstart) % rstep == 0) {
            if lim.min_pressure.is_some() || lim.max_pressure.is_some() {
                let p = h.pressures();
                for (i, id) in ids.iter().enumerate().take(nj) {
                    let v = stored(p[i]);
                    if let Some(l) = lim.min_pressure {
                        e.check("minPressure", id, v, l, true, None);
                    }
                    if let Some(l) = lim.max_pressure {
                        e.check("maxPressure", id, v, l, false, None);
                    }
                }
            }
            let hl = h.unit_headlosses();
            if lim.max_velocity.is_some() || lim.max_headloss.is_some() {
                let vel = h.velocities();
                for (i, len) in net.pipe_length.iter().enumerate() {
                    if len.is_none() {
                        continue;
                    }
                    let id = &net.link_ids[i];
                    if let Some(l) = lim.max_velocity {
                        e.check("maxVelocity", id, stored(vel[i]), l, false, None);
                    }
                    if let Some(l) = lim.max_headloss {
                        e.check("maxHeadloss", id, stored(hl[i]), l, false, None);
                    }
                }
            }
            head_lost(net, &hl, e);
        }
        if h.advance() <= 0 {
            return Ok(());
        }
    }
}

fn fire_flows(m: &Model, net: &Network, f: &FireDemand, e: &mut Eval) -> Result<(), String> {
    let single = at_time(m, f.time);
    let mut base = Hydraulics::new(&single).map_err(|x| x.to_string())?;
    base.run().map_err(|x| x.to_string())?;
    let nj = base.junction_count();
    let ids: Vec<String> = base.node_ids().map(str::to_string).collect();
    for hid in &f.hydrants {
        let node = ids
            .iter()
            .position(|x| x == hid)
            .filter(|&i| i < nj)
            .ok_or_else(|| format!("{hid} is not a junction"))?;
        let mut h = base.clone();
        h.add_constant_demand(node, f.flow)
            .map_err(|x| x.to_string())?;
        h.run()
            .map_err(|x| format!("with fire flow at {hid}: {x}"))?;
        let p = h.pressures();
        e.check("fireResidual", hid, p[node], f.residual, true, Some(hid));
        if let Some(sys) = f.system_min {
            for (j, id) in ids.iter().enumerate().take(nj) {
                if j != node {
                    e.check("fireSystem", id, p[j], sys, true, Some(hid));
                }
            }
        }
        head_lost(net, &h.unit_headlosses(), e);
    }
    Ok(())
}

fn validate(model: &Model, opts: &SizingOptions) -> Result<Vec<PipeSize>, String> {
    if opts.pipes.is_empty() {
        return Err("Give at least one pipe to size.".into());
    }
    if !opts.limits.any() && opts.fire.is_none() {
        return Err("Give at least one limit or a fire flow to size the pipes for.".into());
    }
    let mut sizes = opts.sizes.clone();
    if sizes.is_empty() {
        return Err("Give the pipe sizes available.".into());
    }
    for s in &sizes {
        if !(s.diameter.is_finite() && s.diameter > 0.0) {
            return Err(format!("A size of {} is not a diameter.", s.diameter));
        }
        if !(s.unit_cost.is_finite() && s.unit_cost >= 0.0) {
            return Err(format!(
                "The cost of size {} must be 0 or more.",
                s.diameter
            ));
        }
    }
    sizes.sort_by(|a, b| a.diameter.total_cmp(&b.diameter));
    if sizes.windows(2).any(|w| w[0].diameter == w[1].diameter) {
        return Err("Each size may be listed once.".into());
    }
    if let Some(f) = &opts.fire {
        if f.hydrants.is_empty() {
            return Err("Give the hydrants whose fire flow must be met.".into());
        }
        if !(f.flow.is_finite() && f.flow > 0.0) {
            return Err("The fire flow must be more than 0.".into());
        }
    }
    let missing: Vec<&str> = opts
        .pipes
        .iter()
        .filter(|id| {
            !model
                .links
                .iter()
                .any(|l| &l.id == *id && matches!(l.kind, LinkKind::Pipe(_)))
        })
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Err(format!("These are not pipes: {}.", missing.join(", ")));
    }
    Ok(sizes)
}

fn candidates(model: &Model, opts: &SizingOptions, sizes: &[PipeSize]) -> Vec<Candidate> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in &opts.pipes {
        if !seen.insert(id.as_str()) {
            continue;
        }
        let Some((link, LinkKind::Pipe(p))) = model
            .links
            .iter()
            .enumerate()
            .find(|(_, l)| &l.id == id)
            .map(|(i, l)| (i, &l.kind))
        else {
            continue;
        };
        let same = |d: f64| (d - p.diameter).abs() <= 1e-9 * p.diameter.max(1.0);
        let mut ladder: Vec<(f64, f64, bool)> = sizes
            .iter()
            .filter(|s| opts.from_smallest || s.diameter > p.diameter)
            .map(|s| {
                (
                    s.diameter,
                    s.unit_cost,
                    !opts.from_smallest && same(s.diameter),
                )
            })
            .collect();
        if !opts.from_smallest && !ladder.iter().any(|x| x.2) {
            ladder.push((p.diameter, 0.0, true));
            ladder.sort_by(|a, b| a.0.total_cmp(&b.0));
        }
        let pos = if opts.from_smallest {
            0
        } else {
            ladder.iter().position(|x| x.2).unwrap_or(0)
        };
        out.push(Candidate {
            link,
            id: id.clone(),
            length: p.length,
            original: p.diameter,
            ladder,
            pos,
        });
    }
    out
}

fn sized(model: &Model, cands: &[Candidate], trial: Option<(usize, usize)>) -> Model {
    let mut m = model.clone();
    for (k, c) in cands.iter().enumerate() {
        let pos = match trial {
            Some((i, p)) if i == k => p,
            _ => c.pos,
        };
        if let LinkKind::Pipe(p) = &mut m.links[c.link].kind {
            p.diameter = c.ladder[pos].0;
        }
    }
    m
}

/// Size the pipes: see the module documentation.
pub fn size_pipes(model: &Model, opts: &SizingOptions) -> Result<SizingResult, String> {
    let sizes = validate(model, opts)?;
    let net = Network {
        pipe_length: model
            .links
            .iter()
            .map(|l| match &l.kind {
                LinkKind::Pipe(p) => Some(p.length),
                _ => None,
            })
            .collect(),
        link_ids: model.links.iter().map(|l| l.id.clone()).collect(),
    };
    let budget = opts.max_solutions.unwrap_or(DEFAULT_SOLUTIONS).max(1);
    let as_new = opts.from_smallest;
    let mut cands = candidates(model, opts, &sizes);

    let before = evaluate(model, &net, opts);
    if let Some(err) = &before.error
        && !as_new
    {
        return Err(format!("The network cannot be solved as it is: {err}"));
    }
    let mut solutions = 1;
    let mut cur = if as_new {
        solutions += 1;
        evaluate(&sized(model, &cands, None), &net, opts)
    } else {
        before.clone()
    };
    let mut stopped = None;

    // 1. Enlarge, best shortfall removed per unit cost first.
    while !cur.feasible {
        if solutions >= budget {
            stopped = Some(format!(
                "The search used its {budget} solutions before meeting every limit."
            ));
            break;
        }
        let own: std::collections::HashSet<&str> = cur
            .breaches
            .keys()
            .filter(|(k, _)| *k == "maxVelocity" || *k == "maxHeadloss")
            .map(|(_, id)| id.as_str())
            .collect();
        let mut open: Vec<usize> = (0..cands.len())
            .filter(|&k| cands[k].pos + 1 < cands[k].ladder.len())
            .collect();
        if open.is_empty() {
            stopped = Some("Every pipe is at the largest size and a limit is still broken.".into());
            break;
        }
        open.sort_by(|&a, &b| {
            let ra = cur.relevance[cands[a].link];
            let rb = cur.relevance[cands[b].link];
            rb.total_cmp(&ra).then(a.cmp(&b))
        });
        let (first, rest): (Vec<usize>, Vec<usize>) = {
            let mut first = Vec::new();
            let mut rest = Vec::new();
            for k in open {
                if own.contains(cands[k].id.as_str()) || first.len() < RANKED + own.len() {
                    first.push(k);
                } else {
                    rest.push(k);
                }
            }
            (first, rest)
        };
        let mut best: Option<(usize, f64, Eval)> = None;
        for round in [first, rest] {
            for k in round {
                if solutions >= budget {
                    break;
                }
                let c = &cands[k];
                let e = evaluate(&sized(model, &cands, Some((k, c.pos + 1))), &net, opts);
                solutions += 1;
                let gain = cur.shortfall - e.shortfall;
                if !(gain > 1e-12 || (e.feasible && !cur.feasible && e.error.is_none())) {
                    continue;
                }
                let added = (c.cost_at(c.pos + 1, as_new) - c.cost_at(c.pos, as_new)).max(1e-9);
                // An infinite gain (from an unsolvable network) ranks by cost alone.
                let score = if gain.is_finite() {
                    gain / added
                } else {
                    1e300 / added
                };
                if best.as_ref().is_none_or(|(_, s, _)| score > *s) {
                    best = Some((k, score, e));
                }
            }
            if best.is_some() {
                break;
            }
        }
        match best {
            Some((k, _, e)) => {
                cands[k].pos += 1;
                cur = e;
            }
            None => {
                stopped = Some(if solutions >= budget {
                    format!("The search used its {budget} solutions before meeting every limit.")
                } else {
                    "No larger size on any of the pipes brings the network closer to its limits."
                        .into()
                });
                break;
            }
        }
    }

    // 2. Trim: step pipes back down, largest saving first, while every limit stays met.
    if cur.feasible {
        'trim: loop {
            let mut order: Vec<usize> = (0..cands.len()).filter(|&k| cands[k].pos > 0).collect();
            order.sort_by(|&a, &b| {
                let s = |k: usize| {
                    let c = &cands[k];
                    c.cost_at(c.pos, as_new) - c.cost_at(c.pos - 1, as_new)
                };
                s(b).total_cmp(&s(a)).then(a.cmp(&b))
            });
            for k in order {
                if solutions >= budget {
                    break 'trim;
                }
                let c = &cands[k];
                if !as_new && c.cost_at(c.pos - 1, as_new) >= c.cost_at(c.pos, as_new) {
                    continue; // nothing to save
                }
                let e = evaluate(&sized(model, &cands, Some((k, c.pos - 1))), &net, opts);
                solutions += 1;
                if e.feasible {
                    cands[k].pos -= 1;
                    cur = e;
                    continue 'trim;
                }
            }
            break;
        }
    }

    let changes: Vec<SizeChange> = cands
        .iter()
        .filter(|c| (c.ladder[c.pos].0 - c.original).abs() > 1e-9 * c.original.max(1.0))
        .map(|c| SizeChange {
            id: c.id.clone(),
            from: c.original,
            to: c.ladder[c.pos].0,
            length: c.length,
            cost: c.length * c.ladder[c.pos].1,
        })
        .collect();
    let cost = cands.iter().map(|c| c.cost_at(c.pos, as_new)).sum();
    if let Some(err) = &cur.error {
        stopped.get_or_insert_with(|| format!("The network cannot be solved: {err}"));
    }
    Ok(SizingResult {
        changes,
        cost,
        meets: cur.feasible,
        before: before.listed(),
        after: cur.listed(),
        breaches_before: before.breaches.len(),
        breaches_after: cur.breaches.len(),
        solutions,
        stopped,
    })
}
