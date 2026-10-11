// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (types.h), Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! Constants and data structures, kept close to EPANET's `types.h`.
//!
//! Arrays are 1-based as in the C code (index 0 is unused, except for patterns,
//! where pattern 0 is EPANET's built-in "always 1.0" pattern). This keeps the
//! port reviewable line by line against the reference.

pub const BIG: f64 = 1.0e10;
pub const TINY: f64 = 1.0e-6;
pub const MISSING: f64 = -1.0e10;
pub const VISCOS: f64 = 1.1e-5;
pub const MINPDIFF: f64 = 0.1;
pub const PI: f64 = std::f64::consts::PI;
pub const QZERO: f64 = 1.0e-6;
pub const CSMALL: f64 = 1.0e-6;
pub const CBIG: f64 = 1.0e8;
pub const SECPERDAY: i64 = 86400;

pub const GPM_PER_CFS: f64 = 448.831;
pub const AFD_PER_CFS: f64 = 1.9837;
pub const MGD_PER_CFS: f64 = 0.64632;
pub const IMGD_PER_CFS: f64 = 0.5382;
pub const LPS_PER_CFS: f64 = 28.317;
pub const LPM_PER_CFS: f64 = 1699.0;
pub const CMS_PER_CFS: f64 = 0.028317;
pub const CMH_PER_CFS: f64 = 101.94;
pub const CMD_PER_CFS: f64 = 2446.6;
pub const MLD_PER_CFS: f64 = 2.4466;
pub const M_PER_FT: f64 = 0.3048;
pub const PSI_PER_FT: f64 = 0.4333;
pub const KPA_PER_PSI: f64 = 6.895;
pub const BAR_PER_PSI: f64 = 0.068948;
pub const KW_PER_HP: f64 = 0.7457;

/// `ROUND(x)` from types.h.
pub fn round(x: f64) -> i64 {
    if x >= 0.0 {
        (x + 0.5) as i64
    } else {
        (x - 0.5) as i64
    }
}

/// `SGN(x)` from types.h.
pub fn sgn(x: f64) -> f64 {
    if x < 0.0 { -1.0 } else { 1.0 }
}

/// Transcendental functions come from [`crate::math`], a port of the routines
/// glibc uses, so native and WebAssembly builds compute identical bits and match
/// OWA-EPANET built against glibc (ADR 0003).
pub fn pow(x: f64, y: f64) -> f64 {
    crate::math::pow(x, y)
}

pub fn log(x: f64) -> f64 {
    crate::math::log(x)
}

/// Square root is exactly rounded by IEEE 754 everywhere.
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LinkType {
    CvPipe = 0,
    Pipe = 1,
    Pump = 2,
    Prv = 3,
    Psv = 4,
    Pbv = 5,
    Fcv = 6,
    Tcv = 7,
    Gpv = 8,
    Pcv = 9,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    XHead = 0,
    TempClosed = 1,
    Closed = 2,
    Open = 3,
    Active = 4,
    XFlow = 5,
    XFcv = 6,
    XPressure = 7,
    Filling = 8,
    Emptying = 9,
    Overflowing = 10,
}

impl Status {
    /// The status for its numeric code, as EPANET's hydraulics file stores it.
    pub fn from_code(c: i8) -> Status {
        match c {
            0 => Status::XHead,
            1 => Status::TempClosed,
            2 => Status::Closed,
            3 => Status::Open,
            4 => Status::Active,
            5 => Status::XFlow,
            6 => Status::XFcv,
            7 => Status::XPressure,
            8 => Status::Filling,
            9 => Status::Emptying,
            _ => Status::Overflowing,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeType {
    Junction,
    Reservoir,
    Tank,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PumpType {
    ConstHp,
    PowerFunc,
    Custom,
    NoCurve,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlType {
    LowLevel,
    HiLevel,
    Timer,
    TimeOfDay,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Formula {
    Hw,
    Dw,
    Cm,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnitsType {
    Us,
    Si,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlowUnits {
    Cfs,
    Gpm,
    Mgd,
    Imgd,
    Afd,
    Lps,
    Lpm,
    Mld,
    Cmh,
    Cmd,
    Cms,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PressUnits {
    Psi,
    Kpa,
    Meters,
    Bar,
    Feet,
    Default,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DemandModel {
    Dda,
    Pda,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QualType {
    None,
    Chem,
    Age,
    Trace,
}

/// Indexes into the unit conversion array (EPANET's FieldType).
#[derive(Clone, Copy, Debug)]
pub enum Field {
    Elev = 0,
    Demand,
    Head,
    Pressure,
    Quality,
    Length,
    Diam,
    Flow,
    Velocity,
    Headloss,
    LinkQual,
    Status,
    Setting,
    ReactRate,
    Friction,
    Power,
    Time,
    Volume,
}
pub const MAXVAR: usize = 21;

#[derive(Clone, Debug, Default)]
pub struct Demand {
    pub base: f64,
    /// Pattern index; 0 means the default demand pattern.
    pub pat: usize,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub id: String,
    pub el: f64,
    pub d: Vec<Demand>,
    pub c0: f64,
    pub ke: f64,
    pub node_type: NodeType,
    pub source: Option<crate::quality::Source>,
}

#[derive(Clone, Debug)]
pub struct Link {
    pub id: String,
    pub n1: usize,
    pub n2: usize,
    pub diam: f64,
    pub len: f64,
    pub kc: f64,
    pub km: f64,
    pub kb: f64,
    pub kw: f64,
    pub r: f64,
    pub leak_area: f64,
    pub leak_expan: f64,
    pub link_type: LinkType,
    pub init_status: Status,
    pub init_setting: f64,
    /// Wall reaction rate coefficient for the current flow (`Rc`).
    pub rc: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Tank {
    pub node: usize,
    pub a: f64,
    pub hmin: f64,
    pub hmax: f64,
    pub h0: f64,
    pub vmin: f64,
    pub vmax: f64,
    pub v0: f64,
    pub kb: f64,
    pub v: f64,
    pub c: f64,
    pub pat: usize,
    pub vcurve: usize,
    pub can_overflow: bool,
    pub mix_model: crate::quality::MixModel,
    /// Mixing-compartment volume fraction (`V1frac`).
    pub v1frac: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Energy {
    pub time_on_line: f64,
    pub efficiency: f64,
    pub kw_hrs_per_flow: f64,
    pub kw_hrs: f64,
    pub max_kwatts: f64,
    pub total_cost: f64,
    pub current_power: f64,
    pub current_effic: f64,
}

#[derive(Clone, Debug)]
pub struct Pump {
    pub link: usize,
    pub ptype: PumpType,
    pub q0: f64,
    pub qmax: f64,
    pub hmax: f64,
    pub h0: f64,
    pub r: f64,
    pub n: f64,
    pub hcurve: usize,
    pub ecurve: usize,
    pub upat: usize,
    pub epat: usize,
    pub ecost: f64,
    pub energy: Energy,
}

#[derive(Clone, Debug, Default)]
pub struct Valve {
    pub link: usize,
    pub curve: usize,
}

#[derive(Clone, Debug)]
pub struct Control {
    pub link: usize,
    pub node: usize,
    pub time: i64,
    pub grade: f64,
    pub setting: f64,
    pub status: Status,
    pub control_type: ControlType,
    pub is_enabled: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Pattern {
    pub id: String,
    pub f: Vec<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct Curve {
    pub id: String,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct Leakage {
    pub qfa: f64,
    pub qva: f64,
    pub cfa: f64,
    pub cva: f64,
}

/// The network in EPANET's internal (US) units, 1-based.
#[derive(Clone, Debug, Default)]
pub struct Network {
    pub njuncs: usize,
    pub ntanks: usize,
    pub nnodes: usize,
    pub nlinks: usize,
    pub npumps: usize,
    pub nvalves: usize,
    pub ncontrols: usize,
    pub node: Vec<Node>,
    pub link: Vec<Link>,
    pub tank: Vec<Tank>,
    pub pump: Vec<Pump>,
    pub valve: Vec<Valve>,
    /// 0-based: pattern 0 is EPANET's default pattern of a single 1.0.
    pub pattern: Vec<Pattern>,
    pub curve: Vec<Curve>,
    pub control: Vec<Control>,
}

impl Network {
    /// `findpump` (project.c): pump index of a link, 0 if none.
    pub fn findpump(&self, k: usize) -> usize {
        (1..=self.npumps)
            .find(|&i| self.pump[i].link == k)
            .unwrap_or(0)
    }

    /// `findvalve` (project.c): valve index of a link, 0 if none.
    pub fn findvalve(&self, k: usize) -> usize {
        (1..=self.nvalves)
            .find(|&i| self.valve[i].link == k)
            .unwrap_or(0)
    }
}

/// Time settings (EPANET's Times), in seconds.
#[derive(Clone, Debug)]
pub struct Times {
    pub tstart: i64,
    pub hstep: i64,
    pub pstep: i64,
    pub pstart: i64,
    pub rstep: i64,
    pub rstart: i64,
    pub rtime: i64,
    pub htime: i64,
    pub hydstep: i64,
    pub qtime: i64,
    pub qstep: i64,
    pub rulestep: i64,
    pub dur: i64,
}

impl Default for Times {
    /// `setdefaults` (input1.c).
    fn default() -> Self {
        Times {
            tstart: 0,
            hstep: 3600,
            pstep: 3600,
            pstart: 0,
            rstep: 3600,
            rstart: 0,
            rtime: 0,
            htime: 0,
            hydstep: 0,
            qtime: 0,
            qstep: 0,
            rulestep: 0,
            dur: 0,
        }
    }
}

/// Hydraulic options and state (EPANET's Hydraul).
#[derive(Clone, Debug)]
pub struct Hydraul {
    pub node_head: Vec<f64>,
    pub node_demand: Vec<f64>,
    pub full_demand: Vec<f64>,
    pub demand_flow: Vec<f64>,
    pub emitter_flow: Vec<f64>,
    pub leakage_flow: Vec<f64>,
    pub link_flow: Vec<f64>,
    pub link_setting: Vec<f64>,
    pub htol: f64,
    pub qtol: f64,
    pub rqtol: f64,
    pub hexp: f64,
    pub qexp: f64,
    pub pexp: f64,
    pub pmin: f64,
    pub preq: f64,
    pub dmult: f64,
    pub hacc: f64,
    pub flow_change_limit: f64,
    pub head_error_limit: f64,
    pub damp_limit: f64,
    pub viscos: f64,
    pub sp_grav: f64,
    pub epump: f64,
    pub dsystem: f64,
    pub ecost: f64,
    pub dcost: f64,
    pub emax: f64,
    pub relative_error: f64,
    pub max_head_error: f64,
    pub max_flow_change: f64,
    pub demand_reduction: f64,
    pub relax_factor: f64,
    pub p: Vec<f64>,
    pub y: Vec<f64>,
    pub xflow: Vec<f64>,
    pub def_pat: usize,
    pub epat: usize,
    pub demand_model: DemandModel,
    pub formflag: Formula,
    pub emit_back_flag: bool,
    pub iterations: i32,
    pub max_iter: i32,
    pub extra_iter: i32,
    pub check_freq: i32,
    pub max_check: i32,
    pub haltflag: bool,
    pub deficient_nodes: i32,
    pub has_leakage: bool,
    pub leakage: Vec<Leakage>,
    pub link_status: Vec<Status>,
    pub old_status: Vec<Status>,
}

impl Default for Hydraul {
    /// `setdefaults` (input1.c).
    fn default() -> Self {
        Hydraul {
            node_head: Vec::new(),
            node_demand: Vec::new(),
            full_demand: Vec::new(),
            demand_flow: Vec::new(),
            emitter_flow: Vec::new(),
            leakage_flow: Vec::new(),
            link_flow: Vec::new(),
            link_setting: Vec::new(),
            htol: 0.0005,
            qtol: 0.0001,
            rqtol: 1e-7,
            hexp: 1.852,
            qexp: 2.0,
            pexp: 0.5,
            pmin: 0.0,
            preq: MINPDIFF,
            dmult: 1.0,
            hacc: 0.001,
            flow_change_limit: 0.0,
            head_error_limit: 0.0,
            damp_limit: 0.0,
            viscos: MISSING,
            sp_grav: 1.0,
            epump: 75.0,
            dsystem: 0.0,
            ecost: 0.0,
            dcost: 0.0,
            emax: 0.0,
            relative_error: 0.0,
            max_head_error: 0.0,
            max_flow_change: 0.0,
            demand_reduction: 0.0,
            relax_factor: 1.0,
            p: Vec::new(),
            y: Vec::new(),
            xflow: Vec::new(),
            def_pat: 0,
            epat: 0,
            demand_model: DemandModel::Dda,
            formflag: Formula::Hw,
            emit_back_flag: true,
            iterations: 0,
            max_iter: 200,
            extra_iter: -1,
            check_freq: 2,
            max_check: 10,
            haltflag: false,
            deficient_nodes: 0,
            has_leakage: false,
            leakage: Vec::new(),
            link_status: Vec::new(),
            old_status: Vec::new(),
        }
    }
}

/// Sparse matrix storage (EPANET's Smatrix), 1-based.
#[derive(Clone, Debug, Default)]
pub struct Smatrix {
    pub aii: Vec<f64>,
    pub aij: Vec<f64>,
    pub f: Vec<f64>,
    pub temp: Vec<f64>,
    pub ncoeffs: usize,
    pub order: Vec<usize>,
    pub row: Vec<usize>,
    pub ndx: Vec<usize>,
    pub xlnz: Vec<usize>,
    pub nzsub: Vec<usize>,
    pub lnz: Vec<usize>,
    pub link: Vec<usize>,
    pub first: Vec<usize>,
}

/// Unit settings resolved from the options.
#[derive(Clone, Debug)]
pub struct Units {
    pub unitsflag: UnitsType,
    pub flowflag: FlowUnits,
    pub pressflag: PressUnits,
    pub ucf: [f64; MAXVAR],
}

impl Default for Units {
    fn default() -> Self {
        Units {
            unitsflag: UnitsType::Us,
            flowflag: FlowUnits::Gpm,
            pressflag: PressUnits::Default,
            ucf: [1.0; MAXVAR],
        }
    }
}
