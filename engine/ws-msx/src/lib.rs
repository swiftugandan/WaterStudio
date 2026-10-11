// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0. See LICENSES/EPANET-MSX.txt.

//! Multi-species water quality: a function-by-function Rust port of EPA's
//! EPANET-MSX 2.0 (commit 85a303dc) running over WaterStudio's hydraulics.
//!
//! As with the hydraulic engine (ADR 0006), the port keeps the C code's data layout
//! (1-based arrays), order of operations and floating-point association, so results
//! are checked against the reference build bit for bit (`oracle/msx.sh`). The
//! hydraulics come from `ws-solver` in the single-precision form EPANET's hydraulics
//! file holds, and the network's properties in the form EPANET's legacy toolkit
//! getters return them ([`ws_solver::ToolkitData`]).
//!
//! The one deliberate difference: the `COMPILER` option, which makes the C code
//! compile the chemistry into a shared library, is accepted and ignored; expressions
//! are always interpreted.
//!
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! # let (inp, msx) = (String::new(), String::new());
//! let model = ws_io::read_inp(&inp).model;
//! let mut run = ws_msx::Msx::from_model(&model, &msx, "net.msx")?;
//! run.solve()?;
//! print!("{}", run.report()?);
//! # Ok(()) }
//! ```

#![allow(
    clippy::needless_range_loop,
    clippy::excessive_precision,
    clippy::too_many_arguments,
    clippy::approx_constant,
    clippy::collapsible_match,
    clippy::manual_memcpy,
    clippy::manual_swap
)]

mod chem;
mod dispersion;
mod expr;
mod fp;
mod input;
mod output;
mod qual;
mod segs;
mod solvers;
mod types;

use std::fmt;

use ws_solver::{HydRecord, Hydraulics, ToolkitData};

pub use types::{BULK, WALL};

const ERRMSG: [&str; 25] = [
    "unknown error code.",
    "Error 501 - insufficient memory available.",
    "Error 502 - no EPANET data file supplied.",
    "Error 503 - could not open MSX input file.",
    "Error 504 - could not open hydraulic results file.",
    "Error 505 - could not read hydraulic results file.",
    "Error 506 - could not read MSX input file.",
    "Error 507 - too few pipe reaction expressions.",
    "Error 508 - too few tank reaction expressions.",
    "Error 509 - could not open differential equation solver.",
    "Error 510 - could not open algebraic equation solver.",
    "Error 511 - could not open binary results file.",
    "Error 512 - read/write error on binary results file.",
    "Error 513 - could not integrate reaction rate expressions.",
    "Error 514 - could not solve reaction equilibrium expressions.",
    "Error 515 - reference made to an unknown type of object.",
    "Error 516 - reference made to an illegal object index.",
    "Error 517 - reference made to an undefined object ID.",
    "Error 518 - invalid property values were specified.",
    "Error 519 - an MSX project was not opened.",
    "Error 520 - an MSX project is already opened.",
    "Error 521 - could not open MSX report file.",
    "Error 522 - could not compile chemistry functions.",
    "Error 523 - could not load functions from compiled chemistry file.",
    "Error 524 - illegal math operation.",
];

/// `MSXproj_getErrmsg`
pub fn error_message(code: i32) -> &'static str {
    if code <= 500 || code >= 525 {
        match code {
            120 => "Error 120 - cannot order nodes by flow direction.",
            _ => ERRMSG[0],
        }
    } else {
        ERRMSG[(code - 500) as usize]
    }
}

/// An MSX error: its code (EPANET-MSX's numbering) and the lines the C code writes to
/// the report while failing (input errors with their line, the error text).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MsxError {
    pub code: i32,
    pub messages: Vec<String>,
}

impl MsxError {
    fn new(code: i32) -> MsxError {
        MsxError {
            code,
            messages: vec![error_message(code).to_string()],
        }
    }
}

impl fmt::Display for MsxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail: Vec<&str> = self
            .messages
            .iter()
            .map(|s| s.trim_end())
            .filter(|s| !s.is_empty())
            .collect();
        if detail.is_empty() {
            write!(f, "{}", error_message(self.code))
        } else {
            write!(f, "{}", detail.join("; "))
        }
    }
}

impl std::error::Error for MsxError {}

/// One chemical species.
#[derive(Clone, Debug, PartialEq)]
pub struct SpeciesInfo {
    pub id: String,
    /// [`BULK`] or [`WALL`].
    pub kind: i32,
    /// Concentration units, e.g. "MG/L" or "UG/M2".
    pub units: String,
    /// Reporting precision (decimal places).
    pub precision: i32,
}

/// An EPANET-MSX analysis (`MSXopen` ... `MSXclose`).
#[derive(Clone, Debug)]
pub struct Msx {
    m: types::Model,
    chem: chem::Chem,
    q: qual::Qual,
    out: output::Output,
    messages: Vec<String>,
    /// For each solver node (0-based), its index among the model's nodes, when the
    /// analysis was opened from a model.
    node_order: Vec<usize>,
}

/// Results of every reporting period as f32 columns in the model's element order:
/// `nodes[s][period * node_count + i]` is species `s` (0-based) at model node `i`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Columns {
    pub periods: usize,
    pub nodes: Vec<Vec<f32>>,
    pub links: Vec<Vec<f32>>,
}

impl Msx {
    /// `MSXopen`: read an MSX input file against a network. `file_name` only appears
    /// in the "Processing MSX input file" message.
    pub fn open(net: &ToolkitData, text: &str, file_name: &str) -> Result<Msx, MsxError> {
        let opened = input::open(net, text, file_name).map_err(|e| {
            let mut messages = e.messages;
            messages.push(error_message(e.code).to_string());
            messages.push(String::new());
            MsxError {
                code: e.code,
                messages,
            }
        })?;
        let mut m = opened.model;
        let mut messages = opened.messages;
        let chem = match chem::Chem::open(&mut m) {
            Ok(c) => c,
            Err(code) => {
                messages.push(error_message(code).to_string());
                messages.push(String::new());
                return Err(MsxError { code, messages });
            }
        };
        let q = qual::Qual::open(&m);
        Ok(Msx {
            m,
            chem,
            q,
            out: output::Output::default(),
            messages,
            node_order: (0..net.node_ids.len()).collect(),
        })
    }

    /// Open an analysis for an EPANET model and solve its hydraulics (`ENopen`,
    /// `MSXopen`, `MSXsolveH`).
    pub fn from_model(
        model: &ws_model::Model,
        text: &str,
        file_name: &str,
    ) -> Result<Msx, MsxError> {
        let mut h = Hydraulics::new(model).map_err(|e| MsxError {
            code: e.code,
            messages: vec![e.to_string()],
        })?;
        let mut msx = Msx::open(&h.toolkit_data(), text, file_name)?;
        msx.node_order = h.node_model_index().to_vec();
        h.record_for_quality();
        loop {
            h.run().map_err(|e| MsxError {
                code: e.code,
                messages: vec![e.to_string()],
            })?;
            if h.advance() == 0 {
                break;
            }
        }
        let duration = h.toolkit_data().duration;
        let records = h.records().map(<[HydRecord]>::to_vec).unwrap_or_default();
        msx.use_hydraulics(records, duration);
        Ok(msx)
    }

    /// `MSXusehydfile`: the hydraulic solutions to route over and the simulation
    /// length in seconds.
    pub fn use_hydraulics(&mut self, records: Vec<HydRecord>, duration: i64) {
        self.q.records = records;
        self.q.dur = 1000 * duration;
    }

    /// `MSXinit`: start (or restart) the analysis; `save` keeps results for the
    /// report and the binary output file.
    pub fn init(&mut self, save: bool) -> Result<(), MsxError> {
        self.q.saveflag = save;
        self.q.init(&self.m);
        if self.q.saveflag {
            self.out.open(&self.m);
        }
        Ok(())
    }

    /// `MSXstep`: advance one quality step. Returns the time reached and the time
    /// left, in seconds.
    pub fn step(&mut self) -> Result<(f64, f64), MsxError> {
        let (t, tleft, err) = self.q.step(&self.m, &mut self.chem, &mut self.out);
        if tleft <= 0.0 && self.q.saveflag && err <= 100 {
            self.out.save_final_results(&self.m, &mut self.q);
        }
        if err != 0 {
            let mut e = MsxError::new(err);
            if err == types::ERR_ILLEGAL_MATH {
                e.messages.insert(0, self.chem.vars.math.msg.clone());
            }
            return Err(e);
        }
        Ok((t, tleft))
    }

    /// `MSXsolveQ`: initialize with results saved and run to the end.
    pub fn solve(&mut self) -> Result<(), MsxError> {
        self.init(true)?;
        loop {
            let (_, tleft) = self.step()?;
            if tleft <= 0.0 {
                return Ok(());
            }
        }
    }

    /// `MSXreport`: the results report requested in the input's [REPORT] section
    /// (empty when nothing was requested).
    pub fn report(&self) -> Result<String, MsxError> {
        if !self.q.rptflag {
            return Ok(String::new());
        }
        output::write_report(&self.m, &self.out, &self.q).map_err(MsxError::new)
    }

    /// The report file named in the [REPORT] section, if any.
    pub fn report_file(&self) -> Option<&str> {
        (!self.m.rpt_file.is_empty()).then_some(self.m.rpt_file.as_str())
    }

    /// The binary results file (`MSXsaveoutfile`), once results were saved.
    pub fn output_file(&self) -> Option<&[u8]> {
        self.out.opened.then_some(self.out.file.as_slice())
    }

    /// Lines written to the EPANET report while opening the project.
    pub fn messages(&self) -> &[String] {
        &self.messages
    }

    /// The project title (first [TITLE] line).
    pub fn title(&self) -> &str {
        self.m.title.trim_end()
    }

    pub fn species(&self) -> Vec<SpeciesInfo> {
        (1..=self.m.nsp())
            .map(|i| {
                let s = &self.m.species[i];
                SpeciesInfo {
                    id: s.id.clone(),
                    kind: s.kind,
                    units: self.m.species_units(i),
                    precision: s.precision,
                }
            })
            .collect()
    }

    /// `MSXgetindex(MSX_SPECIES, ...)`, 1-based.
    pub fn species_index(&self, id: &str) -> Option<usize> {
        (1..=self.m.nsp()).find(|&i| self.m.species[i].id == id)
    }

    /// `MSXgetqual(MSX_NODE, ...)`: 1-based node and species indexes.
    pub fn node_quality(&self, node: usize, species: usize) -> f64 {
        if node == 0
            || node > self.m.nobjects[types::NODE]
            || species == 0
            || species > self.m.nsp()
        {
            return 0.0;
        }
        self.q.node_qual(&self.m, node, species)
    }

    /// `MSXgetqual(MSX_LINK, ...)`: 1-based link and species indexes.
    pub fn link_quality(&self, link: usize, species: usize) -> f64 {
        if link == 0
            || link > self.m.nobjects[types::LINK]
            || species == 0
            || species > self.m.nsp()
        {
            return 0.0;
        }
        self.q.link_qual(&self.m, link, species)
    }

    /// Report every period whatever statistic the network's [TIMES] asks for (the
    /// app shows time series). Call before [`Msx::init`].
    pub fn report_series(&mut self) {
        self.m.statflag = types::SERIES;
    }

    /// The saved results as columns in the model's element order (from the binary
    /// results file, so values are the f32 the file holds).
    pub fn columns(&self) -> Columns {
        let m = &self.m;
        let (nn, nl, nsp) = (m.nobjects[types::NODE], m.nobjects[types::LINK], m.nsp());
        let periods = if self.out.opened { self.periods() } else { 0 };
        let mut c = Columns {
            periods,
            nodes: vec![vec![0.0; periods * nn]; nsp],
            links: vec![vec![0.0; periods * nl]; nsp],
        };
        for k in 0..periods {
            for sp in 1..=nsp {
                for j in 1..=nn {
                    let mi = self.node_order.get(j - 1).copied().unwrap_or(j - 1);
                    c.nodes[sp - 1][k * nn + mi] = self.out.node_qual(m, k, j, sp);
                }
                for j in 1..=nl {
                    c.links[sp - 1][k * nl + j - 1] = self.out.link_qual(m, k, j, sp);
                }
            }
        }
        c
    }

    /// Number of reporting periods saved so far.
    pub fn periods(&self) -> usize {
        self.q.nperiods.max(0) as usize
    }

    /// Reporting time step and start, in seconds.
    pub fn report_times(&self) -> (i64, i64) {
        (self.m.rstep, self.m.rstart)
    }
}
