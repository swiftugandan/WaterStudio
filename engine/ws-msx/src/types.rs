// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxtypes.h). See LICENSES/EPANET-MSX.txt.

//! The MSX project's data, laid out as in msxtypes.h: 1-based arrays (entry 0 is an
//! unused placeholder, as the C code allocates `n + 1`).

use crate::expr::MathExpr;

pub const MAXLINE: usize = 1024;
pub const MAXUNITS: usize = 16;
pub const MISSING: f64 = -1.0e10;
pub const PI: f64 = 3.141592654;
pub const TINY: f64 = 1.0e-6;
/// Kinematic viscosity of water at 20 C (ft2/s).
pub const VISCOS: f64 = 1.1e-5;
pub const MAXSEGMENTS: i32 = 5000;

pub const M2_PER_FT2: f64 = 0.09290304;
pub const CM2_PER_FT2: f64 = 929.0304;
pub const GPM_PER_CFS: f64 = 448.831;
pub const AFD_PER_CFS: f64 = 1.9837;
pub const MGD_PER_CFS: f64 = 0.64632;
pub const IMGD_PER_CFS: f64 = 0.5382;
pub const LPS_PER_CFS: f64 = 28.317;
pub const LPM_PER_CFS: f64 = 1699.0;
pub const CMH_PER_CFS: f64 = 101.94;
pub const CMD_PER_CFS: f64 = 2446.6;
pub const MLD_PER_CFS: f64 = 2.4466;
pub const M3_PER_FT3: f64 = 0.028317;
pub const L_PER_FT3: f64 = 28.317;
pub const M_PER_FT: f64 = 0.3048;

/// Object types (`ObjectTypes`).
pub const NODE: usize = 0;
pub const LINK: usize = 1;
pub const TANK: usize = 2;
pub const SPECIES: usize = 3;
pub const TERM: usize = 4;
pub const PARAMETER: usize = 5;
pub const CONSTANT: usize = 6;
pub const PATTERN: usize = 7;
pub const MAX_OBJECTS: usize = 8;

/// Source types (`SourceType`).
pub const CONCEN: i32 = 0;
pub const MASS: i32 = 1;
pub const SETPOINT: i32 = 2;
pub const FLOWPACED: i32 = 3;

/// Unit systems.
pub const US: i32 = 0;
pub const SI: i32 = 1;

/// Tank mixing models (`MixType`).
pub const MIX1: i32 = 0;
pub const MIX2: i32 = 1;
pub const FIFO: i32 = 2;
pub const LIFO: i32 = 3;

/// Species types.
pub const BULK: i32 = 0;
pub const WALL: i32 = 1;

/// Expression types (`ExpressionType`).
pub const NO_EXPR: i32 = 0;
pub const RATE: i32 = 1;
pub const FORMULA: i32 = 2;
pub const EQUIL: i32 = 3;

/// ODE solvers.
pub const EUL: i32 = 0;
pub const RK5: i32 = 1;
pub const ROS2: i32 = 2;

/// Coupling between algebraic and differential equations.
pub const NO_COUPLING: i32 = 0;
pub const FULL_COUPLING: i32 = 1;

/// Surface area units.
pub const FT2: i32 = 0;
pub const M2: i32 = 1;
pub const CM2: i32 = 2;

/// Unit conversion slots (`UnitsType`).
pub const LENGTH_UNITS: usize = 0;
pub const DIAM_UNITS: usize = 1;
pub const AREA_UNITS: usize = 2;
pub const VOL_UNITS: usize = 3;
pub const FLOW_UNITS: usize = 4;
pub const CONC_UNITS: usize = 5;
pub const RATE_UNITS: usize = 6;
pub const MAX_UNIT_TYPES: usize = 7;

/// Hydraulic variables (`HydVarType`), 1-based.
pub const DIAMETER: usize = 1;
pub const FLOW: usize = 2;
pub const VELOCITY: usize = 3;
pub const REYNOLDS: usize = 4;
pub const SHEAR: usize = 5;
pub const FRICTION: usize = 6;
pub const AREAVOL: usize = 7;
pub const ROUGHNESS: usize = 8;
pub const LENGTH: usize = 9;
pub const MAX_HYD_VARS: usize = 10;

/// Time-series statistics (`TstatType`).
pub const SERIES: i32 = 0;
pub const AVERAGE: i32 = 1;
pub const MAXIMUM: i32 = 3;
pub const RANGE: i32 = 4;

/// Error codes (`ErrorCodeType`).
pub const ERR_MSX_INPUT: i32 = 506;
pub const ERR_NUM_PIPE_EXPR: i32 = 507;
pub const ERR_NUM_TANK_EXPR: i32 = 508;
pub const ERR_OPEN_OUT_FILE: i32 = 511;
pub const ERR_IO_OUT_FILE: i32 = 512;
pub const ERR_INTEGRATOR: i32 = 513;
pub const ERR_NEWTON: i32 = 514;
pub const ERR_READ_HYD_FILE: i32 = 505;
pub const ERR_ILLEGAL_MATH: i32 = 524;

/// Keywords (msxdict.h).
pub const MSX_SECT_WORDS: [&str; 13] = [
    "[TITLE", "[SPECIE", "[COEFF", "[TERM", "[PIPE", "[TANK", "[SOURCE", "[QUALITY", "[PARAM",
    "[PATTERN", "[OPTION", "[REPORT", "[DIFFU",
];
pub const REPORT_WORDS: [&str; 5] = ["NODE", "LINK", "SPECIE", "FILE", "PAGESIZE"];
pub const OPTION_TYPE_WORDS: [&str; 10] = [
    "AREA_UNITS",
    "RATE_UNITS",
    "SOLVER",
    "COUPLING",
    "TIMESTEP",
    "RTOL",
    "ATOL",
    "COMPILER",
    "SEGMENTS",
    "PECLET",
];
pub const COMPILER_WORDS: [&str; 3] = ["NONE", "VC", "GC"];
pub const SOURCE_TYPE_WORDS: [&str; 4] = ["CONC", "MASS", "SETPOINT", "FLOW"];
pub const AREA_UNITS_WORDS: [&str; 3] = ["FT2", "M2", "CM2"];
pub const TIME_UNITS_WORDS: [&str; 4] = ["SEC", "MIN", "HR", "DAY"];
pub const SOLVER_TYPE_WORDS: [&str; 3] = ["EUL", "RK5", "ROS2"];
pub const COUPLING_WORDS: [&str; 2] = ["NONE", "FULL"];
pub const EXPR_TYPE_WORDS: [&str; 4] = ["", "RATE", "FORMULA", "EQUIL"];
pub const HYD_VAR_WORDS: [&str; 10] = ["", "D", "Q", "U", "Re", "Us", "Ff", "Av", "Kc", "Len"];

/// A water quality source at a node (`Ssource`).
#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub kind: i32,
    pub species: usize,
    pub c0: f64,
    pub pat: usize,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Pattern {
    pub id: String,
    pub values: Vec<f64>,
}

/// Node input data (the static part of `Snode`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NodeData {
    /// Sources, newest first (the C code pushes onto the front of a list).
    pub sources: Vec<Source>,
    pub c0: Vec<f64>,
    pub tank: usize,
    pub rpt: bool,
}

/// Link input data (the static part of `Slink`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LinkData {
    pub n1: usize,
    pub n2: usize,
    pub diam: f64,
    pub len: f64,
    pub rpt: bool,
    pub c0: Vec<f64>,
    pub param: Vec<f64>,
    pub roughness: f64,
}

/// Tank input data (the static part of `Stank`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TankData {
    pub node: usize,
    pub a: f64,
    pub v0: f64,
    pub mix_model: i32,
    pub v_mix: f64,
    pub param: Vec<f64>,
}

/// A chemical species (`Sspecies`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Species {
    pub id: String,
    pub units: String,
    pub a_tol: f64,
    pub r_tol: f64,
    pub kind: i32,
    pub pipe_expr_type: i32,
    pub tank_expr_type: i32,
    pub precision: i32,
    pub rpt: bool,
    pub pipe_expr: Option<MathExpr>,
    pub tank_expr: Option<MathExpr>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Term {
    pub id: String,
    pub expr: Option<MathExpr>,
}

/// A reaction parameter or a constant.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Coeff {
    pub id: String,
    pub value: f64,
}

/// Settings for the dispersion model.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DispersionData {
    pub relative_viscosity: f64,
    pub viscosity: f64,
    pub diffus: f64,
    pub peclet_limit: f64,
    /// Molecular diffusivity per species (negative if not given).
    pub md: Vec<f64>,
    /// Fixed longitudinal dispersion coefficient per species (negative if not given).
    pub ld: Vec<f64>,
}

/// Everything read from the EPANET network and the MSX input file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Model {
    pub title: String,
    pub nobjects: [usize; MAX_OBJECTS],
    pub unitsflag: i32,
    pub flowflag: i32,
    pub coupling: i32,
    pub compiler: i32,
    pub area_units: i32,
    pub rate_units: i32,
    pub solver: i32,
    pub page_size: i32,
    pub max_segments: i32,
    pub pstep: i64,
    pub pstart: i64,
    pub rstep: i64,
    pub rstart: i64,
    pub statflag: i32,
    /// Quality time step in milliseconds.
    pub qstep: i64,
    pub ucf: [f64; MAX_UNIT_TYPES],
    pub def_rtol: f64,
    pub def_atol: f64,
    /// Initial quality given by GLOBAL lines.
    pub c0: Vec<f64>,
    pub species: Vec<Species>,
    pub params: Vec<Coeff>,
    pub consts: Vec<Coeff>,
    pub terms: Vec<Term>,
    pub nodes: Vec<NodeData>,
    pub links: Vec<LinkData>,
    pub tanks: Vec<TankData>,
    pub patterns: Vec<Pattern>,
    pub rpt_file: String,
    pub dispersion_flag: bool,
    pub dispersion: DispersionData,
    pub node_ids: Vec<String>,
    pub link_ids: Vec<String>,
}

impl Model {
    pub fn nsp(&self) -> usize {
        self.nobjects[SPECIES]
    }

    /// `MSXinp_getSpeciesUnits`
    pub fn species_units(&self, m: usize) -> String {
        let s = &self.species[m];
        let area = AREA_UNITS_WORDS
            .get(self.area_units as usize)
            .copied()
            .unwrap_or("");
        format!("{}/{}", s.units, if s.kind == BULK { "L" } else { area })
    }
}
