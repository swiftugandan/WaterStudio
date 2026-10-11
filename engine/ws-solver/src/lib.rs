// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5, Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! WaterStudio's hydraulic engine: a function-by-function Rust port of OWA-EPANET
//! 2.3.5's hydraulic solver (ADR 0006).
//!
//! The port keeps EPANET's data layout (1-based arrays, junctions before tanks), its
//! order of operations and its floating-point association, so results match the
//! reference engine to the last few bits rather than to a tolerance. Function names
//! follow the C source so the two can be read side by side.
//!
//! [`Hydraulics`] steps a run the way `EN_openH`/`EN_initH`/`EN_runH`/`EN_nextH` do;
//! [`solve_hydraulics`] runs a whole simulation and keeps the report periods.

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
}

/// A hydraulic simulation in progress.
#[derive(Clone, Debug)]
pub struct Hydraulics {
    pr: Project,
}

impl Hydraulics {
    /// Build the solver's network from a model and open the solver (`EN_open` +
    /// `EN_openH` + `EN_initH(0)`).
    pub fn new(model: &Model) -> Result<Self, SolverError> {
        let mut pr = input::build(model)?;
        hydraul::openhyd(&mut pr)?;
        leakage::openleakage(&mut pr);
        hydraul::inithyd(&mut pr, false);
        Ok(Hydraulics { pr })
    }

    /// Solve at the current time (`EN_runH`). Returns the current time in seconds.
    pub fn run(&mut self) -> Result<i64, SolverError> {
        hydraul::runhyd(&mut self.pr)?;
        Ok(self.pr.times.htime)
    }

    /// Advance to the next hydraulic event (`EN_nextH`). Returns the step taken in
    /// seconds; 0 when the simulation is over.
    pub fn advance(&mut self) -> i64 {
        hydraul::nexthyd(&mut self.pr)
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

    /// Relative flow change of the last solution and the trials it took.
    pub fn convergence(&self) -> (f64, i32) {
        (self.pr.hyd.relative_error, self.pr.hyd.iterations)
    }
}

/// Results of a whole run at each report period, in the model's units. Series are
/// indexed `[period][element]`; period k is at `report_start + k * report_step`.
#[derive(Clone, Debug, Default)]
pub struct HydraulicResults {
    pub report_start: i64,
    pub report_step: i64,
    pub node_ids: Vec<String>,
    pub link_ids: Vec<String>,
    pub heads: Vec<Vec<f64>>,
    pub demands: Vec<Vec<f64>>,
    pub flows: Vec<Vec<f64>>,
}

/// Run a model's hydraulics over its whole duration (`EN_solveH`), keeping the
/// solution of each report period the way EPANET's output file does: a period
/// takes the first solution at or after its time.
pub fn solve_hydraulics(model: &Model) -> Result<HydraulicResults, SolverError> {
    let mut h = Hydraulics::new(model)?;
    let (rstart, rstep) = (h.pr.times.rstart, h.pr.times.rstep);
    let mut out = HydraulicResults {
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
    Ok(out)
}
