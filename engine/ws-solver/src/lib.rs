// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5, Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! WaterStudio's engine: a function-by-function Rust port of OWA-EPANET 2.3.5's
//! hydraulic and water-quality solvers (ADR 0006).
//!
//! The port keeps EPANET's data layout (1-based arrays, junctions before tanks), its
//! order of operations and its floating-point association, so results match the
//! reference engine to the last few bits rather than to a tolerance. Function names
//! follow the C source so the two can be read side by side.
//!
//! [`Hydraulics`] steps a run the way `EN_openH`/`EN_initH`/`EN_runH`/`EN_nextH` do;
//! [`WaterQuality`] then routes quality over the recorded solutions as
//! `EN_openQ`/`EN_initQ`/`EN_runQ`/`EN_nextQ` do; [`simulate`] runs both over a whole
//! simulation and keeps the report periods.

// The port mirrors the C source line for line. These lints would rewrite loops and
// constants away from that shape without changing a single result.
#![allow(
    clippy::excessive_precision,
    clippy::needless_range_loop,
    clippy::assign_op_pattern,
    clippy::too_many_arguments,
    clippy::if_same_then_else
)]

mod coeffs;
mod error;
mod genmmd;
mod hydraul;
mod input;
mod leakage;
pub mod math;
mod quality;
mod rules;
mod smatrix;
mod solver;
mod status;
mod types;

pub use error::SolverError;
pub use types::{Field, LinkType, NodeType, Status};

use types::*;
use ws_model::Model;

/// Everything the solver knows about a project: network data, options, units and
/// the current hydraulic state (EPANET's `Project`, without the I/O parts).
#[derive(Clone, Debug, Default)]
pub struct Project {
    pub(crate) net: Network,
    pub(crate) hyd: Hydraul,
    pub(crate) sm: Smatrix,
    pub(crate) times: Times,
    pub(crate) units: Units,
    pub(crate) rules: Vec<rules::Rule>,
    pub(crate) qual: quality::Quality,
    /// For each solver node index (1-based; entry 0 unused), its index in `Model::nodes`.
    pub(crate) node_order: Vec<usize>,
}

/// A hydraulic simulation in progress.
#[derive(Clone, Debug)]
pub struct Hydraulics {
    pr: Project,
    /// Solutions kept for a water-quality run (EPANET's hydraulics file).
    records: Option<Vec<quality::HydRecord>>,
}

impl Hydraulics {
    /// Build the solver's network from a model and open the solver (`EN_open` +
    /// `EN_openH` + `EN_initH(0)`).
    pub fn new(model: &Model) -> Result<Self, SolverError> {
        let mut pr = input::build(model)?;
        hydraul::openhyd(&mut pr)?;
        leakage::openleakage(&mut pr);
        hydraul::inithyd(&mut pr, false);
        Ok(Hydraulics { pr, records: None })
    }

    /// Whether the model asks for a water-quality analysis (chemical, age or trace).
    pub fn has_quality(&self) -> bool {
        self.pr.qual.qualflag != QualType::None
    }

    /// Keep every hydraulic solution from now on, so [`Hydraulics::into_quality`] can
    /// route water quality over them (`EN_initH` with `EN_SAVE`). Call before the
    /// first [`Hydraulics::run`].
    pub fn record_for_quality(&mut self) {
        self.records = Some(Vec::new());
    }

    /// Initial qualities in user units: what EPANET reports for nodes when no quality
    /// analysis runs.
    pub fn initial_qualities(&self) -> Vec<f64> {
        let u = self.ucf(Field::Quality);
        self.pr.net.node[1..].iter().map(|n| n.c0 * u).collect()
    }

    /// After the hydraulic run has finished, start a water-quality run over the
    /// recorded solutions (`EN_closeH`, `EN_openQ`, `EN_initQ`).
    pub fn into_quality(self) -> Result<WaterQuality, SolverError> {
        let Some(records) = self.records else {
            return Err(SolverError::new(
                104,
                "no hydraulics recorded for a quality run",
            ));
        };
        let mut pr = self.pr;
        quality::openqual(&mut pr)
            .map_err(|c| SolverError::new(c, "cannot open the quality solver"))?;
        quality::initqual(&mut pr);
        Ok(WaterQuality {
            pr,
            records,
            next: 0,
        })
    }

    /// Solve at the current time (`EN_runH`). Returns the current time in seconds.
    pub fn run(&mut self) -> Result<i64, SolverError> {
        hydraul::runhyd(&mut self.pr)?;
        Ok(self.pr.times.htime)
    }

    /// Advance to the next hydraulic event (`EN_nextH`). Returns the step taken in
    /// seconds; 0 when the simulation is over.
    pub fn advance(&mut self) -> i64 {
        match &mut self.records {
            Some(records) => {
                // nexthyd saves the solution before it moves on, then the step.
                let mut r = quality::savehyd(&self.pr, self.pr.times.htime);
                let step = hydraul::nexthyd(&mut self.pr);
                r.hydstep = step;
                records.push(r);
                step
            }
            None => hydraul::nexthyd(&mut self.pr),
        }
    }

    /// Current simulation time in seconds.
    pub fn time(&self) -> i64 {
        self.pr.times.htime
    }

    pub fn node_count(&self) -> usize {
        self.pr.net.nnodes
    }

    pub fn link_count(&self) -> usize {
        self.pr.net.nlinks
    }

    /// Node IDs in solver order: junctions, then tanks and reservoirs.
    pub fn node_ids(&self) -> impl Iterator<Item = &str> {
        self.pr.net.node.iter().skip(1).map(|n| n.id.as_str())
    }

    /// Link IDs in input order.
    pub fn link_ids(&self) -> impl Iterator<Item = &str> {
        self.pr.net.link.iter().skip(1).map(|l| l.id.as_str())
    }

    fn ucf(&self, f: Field) -> f64 {
        self.pr.units.ucf[f as usize]
    }

    /// Hydraulic heads in user units.
    pub fn heads(&self) -> Vec<f64> {
        let u = self.ucf(Field::Head);
        self.pr.hyd.node_head[1..].iter().map(|h| h * u).collect()
    }

    /// Pressures in user units.
    pub fn pressures(&self) -> Vec<f64> {
        let u = self.ucf(Field::Pressure);
        let net = &self.pr.net;
        (1..=net.nnodes)
            .map(|i| (self.pr.hyd.node_head[i] - net.node[i].el) * u)
            .collect()
    }

    /// Node demands in user units. A tank's or reservoir's demand is its net inflow.
    pub fn demands(&self) -> Vec<f64> {
        let u = self.ucf(Field::Demand);
        self.pr.hyd.node_demand[1..].iter().map(|d| d * u).collect()
    }

    /// Link flows in user units; a closed link reports zero, as EPANET's output does.
    pub fn flows(&self) -> Vec<f64> {
        let u = self.ucf(Field::Flow);
        let hyd = &self.pr.hyd;
        (1..=self.pr.net.nlinks)
            .map(|k| {
                if hyd.link_status[k] <= Status::Closed {
                    0.0
                } else {
                    hyd.link_flow[k] * u
                }
            })
            .collect()
    }

    /// Pipe leakage flows in user flow units (zero for links without leakage).
    pub fn leakages(&self) -> Vec<f64> {
        let u = self.ucf(Field::Flow);
        (1..=self.pr.net.nlinks)
            .map(|k| leakage::findlinkleakage(&self.pr, k) * u)
            .collect()
    }

    /// Link status codes, as EPANET writes them to its output file.
    pub fn statuses(&self) -> Vec<Status> {
        self.pr.hyd.link_status[1..].to_vec()
    }

    /// For each solver node (in [`Hydraulics::node_ids`] order), its index in the model's
    /// `nodes`. Links are in model order already.
    pub fn node_model_index(&self) -> &[usize] {
        &self.pr.node_order[1..]
    }

    /// Report start and step, and the simulation duration, in seconds.
    pub fn report_times(&self) -> (i64, i64, i64) {
        (self.pr.times.rstart, self.pr.times.rstep, self.pr.times.dur)
    }

    /// Consumer demand requested but not delivered under pressure-driven analysis
    /// (`EN_DEMANDDEFICIT`); zero for tanks and reservoirs.
    pub fn demand_deficits(&self) -> Vec<f64> {
        let u = self.ucf(Field::Flow);
        let hyd = &self.pr.hyd;
        (1..=self.pr.net.nnodes)
            .map(|i| {
                if i > self.pr.net.njuncs || hyd.full_demand[i] <= 0.0 {
                    return 0.0;
                }
                ((hyd.full_demand[i] - hyd.demand_flow[i]) * u).max(0.0)
            })
            .collect()
    }

    /// Emitter outflows (`EN_EMITTERFLOW`).
    pub fn emitter_flows(&self) -> Vec<f64> {
        let u = self.ucf(Field::Flow);
        self.pr.hyd.emitter_flow[1..]
            .iter()
            .map(|q| q * u)
            .collect()
    }

    /// Pipe leakage assigned to each node (`EN_LEAKAGEFLOW`).
    pub fn node_leakages(&self) -> Vec<f64> {
        let u = self.ucf(Field::Flow);
        self.pr.hyd.leakage_flow[1..]
            .iter()
            .map(|q| q * u)
            .collect()
    }

    /// Flow velocities (`EN_VELOCITY`); zero for pumps and closed links.
    pub fn velocities(&self) -> Vec<f64> {
        let u = self.ucf(Field::Velocity);
        let (net, hyd) = (&self.pr.net, &self.pr.hyd);
        (1..=net.nlinks)
            .map(|k| {
                let l = &net.link[k];
                if l.link_type == LinkType::Pump || hyd.link_status[k] <= Status::Closed {
                    0.0
                } else {
                    hyd.link_flow[k].abs() / (PI * (l.diam * l.diam) / 4.0) * u
                }
            })
            .collect()
    }

    /// Head loss as EPANET's map and output file show it: per 1000 length units for
    /// pipes, total head change for pumps and valves; zero for closed links.
    pub fn unit_headlosses(&self) -> Vec<f64> {
        let u = self.ucf(Field::Headloss);
        let (net, hyd) = (&self.pr.net, &self.pr.hyd);
        (1..=net.nlinks)
            .map(|k| {
                let l = &net.link[k];
                if hyd.link_status[k] <= Status::Closed {
                    return 0.0;
                }
                let mut h = hyd.node_head[l.n1] - hyd.node_head[l.n2];
                if l.link_type != LinkType::Pump {
                    h = h.abs();
                }
                if l.link_type <= LinkType::Pipe {
                    1000.0 * h / l.len
                } else {
                    h * u
                }
            })
            .collect()
    }

    /// Current settings in user units, as EPANET's output file stores them: roughness
    /// for pipes, relative speed for pumps, the control setting for valves (0 if none).
    pub fn settings(&self) -> Vec<f64> {
        let (net, hyd, ucf) = (&self.pr.net, &self.pr.hyd, &self.pr.units.ucf);
        (1..=net.nlinks)
            .map(|k| {
                let s = hyd.link_setting[k];
                if s == MISSING {
                    return 0.0;
                }
                match net.link[k].link_type {
                    LinkType::Prv | LinkType::Psv | LinkType::Pbv => {
                        s * ucf[Field::Pressure as usize]
                    }
                    LinkType::Fcv => s * ucf[Field::Flow as usize],
                    LinkType::Gpv => 0.0,
                    _ => s,
                }
            })
            .collect()
    }

    /// Relative flow change of the last solution and the trials it took.
    pub fn convergence(&self) -> (f64, i32) {
        (self.pr.hyd.relative_error, self.pr.hyd.iterations)
    }
}

/// A water-quality run over a finished hydraulic run, stepped the way
/// `EN_runQ`/`EN_nextQ` do.
#[derive(Clone, Debug)]
pub struct WaterQuality {
    pr: Project,
    records: Vec<quality::HydRecord>,
    next: usize,
}

impl WaterQuality {
    /// Load the hydraulic solution at the current time (`EN_runQ`). Returns the
    /// current time in seconds.
    pub fn run(&mut self) -> Result<i64, SolverError> {
        let t = &self.pr.times;
        if t.qtime == t.htime {
            let r = self
                .records
                .get(self.next)
                .ok_or_else(|| SolverError::new(307, "ran past the recorded hydraulics"))?
                .clone();
            self.next += 1;
            quality::readhyd(&mut self.pr, &r);
            self.pr.times.htime = r.htime;
            if self.pr.times.htime >= self.pr.times.rtime {
                self.pr.times.rtime += self.pr.times.rstep;
            }
            quality::runqual_update(&mut self.pr)
                .map_err(|c| SolverError::new(c, "cannot order nodes by flow direction"))?;
            self.pr.times.htime = r.htime + r.hydstep;
        }
        Ok(self.pr.times.qtime)
    }

    /// Route quality to the next hydraulic event (`EN_nextQ`). Returns the step taken
    /// in seconds; 0 when the simulation is over.
    pub fn advance(&mut self) -> i64 {
        quality::nextqual(&mut self.pr)
    }

    /// Node qualities in user units: concentration, age in hours or percent traced.
    pub fn node_qualities(&self) -> Vec<f64> {
        let u = self.pr.units.ucf[Field::Quality as usize];
        self.pr.qual.node_qual[1..].iter().map(|c| c * u).collect()
    }

    /// Average quality along each link, in user units.
    pub fn link_qualities(&self) -> Vec<f64> {
        let u = self.pr.units.ucf[Field::LinkQual as usize];
        (1..=self.pr.net.nlinks)
            .map(|k| quality::avgqual(&self.pr, k) * u)
            .collect()
    }

    /// The system mass balance ratio (mass out / mass in); 1 is perfect.
    pub fn mass_balance_ratio(&self) -> f64 {
        self.pr.qual.mass.ratio
    }
}

/// Results of a whole run at each report period, in the model's units. Series are
/// indexed `[period][element]`; period k is at `report_start + k * report_step`.
/// The quality series are empty when the model asks for no quality analysis.
#[derive(Clone, Debug, Default)]
pub struct SimulationResults {
    pub report_start: i64,
    pub report_step: i64,
    pub node_ids: Vec<String>,
    pub link_ids: Vec<String>,
    pub heads: Vec<Vec<f64>>,
    pub demands: Vec<Vec<f64>>,
    pub flows: Vec<Vec<f64>>,
    pub node_quality: Vec<Vec<f64>>,
    pub link_quality: Vec<Vec<f64>>,
}

/// Run a model over its whole duration as EPANET's `EN_solveH` then `EN_solveQ` do,
/// keeping the solution of each report period the way EPANET's output file does: a
/// period takes the first solution at or after its time. Water quality runs only when
/// the model asks for it.
pub fn simulate(model: &Model) -> Result<SimulationResults, SolverError> {
    let mut h = Hydraulics::new(model)?;
    let quality = h.has_quality();
    if quality {
        h.record_for_quality();
    }
    let (rstart, rstep) = (h.pr.times.rstart, h.pr.times.rstep);
    let mut out = SimulationResults {
        report_start: rstart,
        report_step: rstep,
        node_ids: h.node_ids().map(str::to_string).collect(),
        link_ids: h.link_ids().map(str::to_string).collect(),
        ..Default::default()
    };
    let mut rtime = rstart;
    loop {
        let t = h.run()?;
        if t >= rtime {
            out.heads.push(h.heads());
            out.demands.push(h.demands());
            out.flows.push(h.flows());
            rtime += rstep;
        }
        if h.advance() <= 0 {
            break;
        }
    }
    if quality {
        let mut q = h.into_quality()?;
        let mut rtime = rstart;
        loop {
            let t = q.run()?;
            if t >= rtime {
                out.node_quality.push(q.node_qualities());
                out.link_quality.push(q.link_qualities());
                rtime += rstep;
            }
            if q.advance() <= 0 {
                break;
            }
        }
    }
    Ok(out)
}
