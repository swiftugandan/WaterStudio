// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (epanet.c), Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! EPANET's toolkit API (`epanet.c`), function by function over the ported solver.
//!
//! [`Toolkit`] is an `EN_Project`. Its methods keep the C functions' names, arguments,
//! error codes and output conventions (outputs are written through `&mut`, including the
//! defaults the C code writes before it checks its arguments), so `ws-ffi` only has to
//! copy values across the C boundary and the two can be read side by side. Values come
//! from the same `Project` the solver uses, so they match `libepanet2` to the bit;
//! `oracle/toolkit.sh` checks that on every network.
//!
//! Network data EPANET keeps but the solver does not need (comments, tags, coordinates,
//! vertices, demand category names) come from the model the project was opened from.
//! The hydraulics file is kept in memory as [`HydRecord`]s.

use crate::hydraul;
use crate::quality::{self, HydRecord};
use crate::types::*;
use crate::{Project, leakage};
use ws_model::Model;

pub const CODEVERSION: i32 = 20305;
pub const MAXID: usize = 31;
pub const MAXMSG: usize = 255;
pub const TITLELEN: usize = 79;
const SET_OPEN: f64 = 1.0e10;
const SET_CLOSED: f64 = -1.0e10;
const DIFFUS: f64 = 1.3e-8;
const SECPERDAY_F: f64 = 86400.0;

// EN_NodeProperty
pub const EN_ELEVATION: i32 = 0;
pub const EN_BASEDEMAND: i32 = 1;
pub const EN_PATTERN: i32 = 2;
pub const EN_EMITTER: i32 = 3;
pub const EN_INITQUAL: i32 = 4;
pub const EN_SOURCEQUAL: i32 = 5;
pub const EN_SOURCEPAT: i32 = 6;
pub const EN_SOURCETYPE: i32 = 7;
pub const EN_TANKLEVEL: i32 = 8;
pub const EN_DEMAND: i32 = 9;
pub const EN_HEAD: i32 = 10;
pub const EN_PRESSURE: i32 = 11;
pub const EN_QUALITY: i32 = 12;
pub const EN_SOURCEMASS: i32 = 13;
pub const EN_INITVOLUME: i32 = 14;
pub const EN_MIXMODEL: i32 = 15;
pub const EN_MIXZONEVOL: i32 = 16;
pub const EN_TANKDIAM: i32 = 17;
pub const EN_MINVOLUME: i32 = 18;
pub const EN_VOLCURVE: i32 = 19;
pub const EN_MINLEVEL: i32 = 20;
pub const EN_MAXLEVEL: i32 = 21;
pub const EN_MIXFRACTION: i32 = 22;
pub const EN_TANK_KBULK: i32 = 23;
pub const EN_TANKVOLUME: i32 = 24;
pub const EN_MAXVOLUME: i32 = 25;
pub const EN_CANOVERFLOW: i32 = 26;
pub const EN_DEMANDDEFICIT: i32 = 27;
pub const EN_NODE_INCONTROL: i32 = 28;
pub const EN_EMITTERFLOW: i32 = 29;
pub const EN_LEAKAGEFLOW: i32 = 30;
pub const EN_DEMANDFLOW: i32 = 31;
pub const EN_FULLDEMAND: i32 = 32;

// EN_LinkProperty
pub const EN_DIAMETER: i32 = 0;
pub const EN_LENGTH: i32 = 1;
pub const EN_ROUGHNESS: i32 = 2;
pub const EN_MINORLOSS: i32 = 3;
pub const EN_INITSTATUS: i32 = 4;
pub const EN_INITSETTING: i32 = 5;
pub const EN_KBULK: i32 = 6;
pub const EN_KWALL: i32 = 7;
pub const EN_FLOW: i32 = 8;
pub const EN_VELOCITY: i32 = 9;
pub const EN_HEADLOSS: i32 = 10;
pub const EN_STATUS: i32 = 11;
pub const EN_SETTING: i32 = 12;
pub const EN_ENERGY: i32 = 13;
pub const EN_LINKQUAL: i32 = 14;
pub const EN_LINKPATTERN: i32 = 15;
pub const EN_PUMP_STATE: i32 = 16;
pub const EN_PUMP_EFFIC: i32 = 17;
pub const EN_PUMP_POWER: i32 = 18;
pub const EN_PUMP_HCURVE: i32 = 19;
pub const EN_PUMP_ECURVE: i32 = 20;
pub const EN_PUMP_ECOST: i32 = 21;
pub const EN_PUMP_EPAT: i32 = 22;
pub const EN_LINK_INCONTROL: i32 = 23;
pub const EN_GPV_CURVE: i32 = 24;
pub const EN_PCV_CURVE: i32 = 25;
pub const EN_LEAK_AREA: i32 = 26;
pub const EN_LEAK_EXPAN: i32 = 27;
pub const EN_LINK_LEAKAGE: i32 = 28;
pub const EN_VALVE_TYPE: i32 = 29;

// EN_TimeParameter
pub const EN_DURATION: i32 = 0;
pub const EN_HYDSTEP: i32 = 1;
pub const EN_QUALSTEP: i32 = 2;
pub const EN_PATTERNSTEP: i32 = 3;
pub const EN_PATTERNSTART: i32 = 4;
pub const EN_REPORTSTEP: i32 = 5;
pub const EN_REPORTSTART: i32 = 6;
pub const EN_RULESTEP: i32 = 7;
pub const EN_STATISTIC: i32 = 8;
pub const EN_PERIODS: i32 = 9;
pub const EN_STARTTIME: i32 = 10;
pub const EN_HTIME: i32 = 11;
pub const EN_QTIME: i32 = 12;
pub const EN_HALTFLAG: i32 = 13;
pub const EN_NEXTEVENT: i32 = 14;
pub const EN_NEXTEVENTTANK: i32 = 15;

// EN_TimestepEvent
pub const EN_STEP_HYD: i32 = 1;
pub const EN_STEP_TANKEVENT: i32 = 3;
pub const EN_STEP_CONTROLEVENT: i32 = 4;

// EN_AnalysisStatistic
pub const EN_ITERATIONS: i32 = 0;
pub const EN_RELATIVEERROR: i32 = 1;
pub const EN_MAXHEADERROR: i32 = 2;
pub const EN_MAXFLOWCHANGE: i32 = 3;
pub const EN_MASSBALANCE: i32 = 4;
pub const EN_DEFICIENTNODES: i32 = 5;
pub const EN_DEMANDREDUCTION: i32 = 6;
pub const EN_LEAKAGELOSS: i32 = 7;

// EN_ObjectType, EN_CountType
pub const EN_NODE: i32 = 0;
pub const EN_LINK: i32 = 1;
pub const EN_TIMEPAT: i32 = 2;
pub const EN_CURVE: i32 = 3;
pub const EN_NODECOUNT: i32 = 0;
pub const EN_TANKCOUNT: i32 = 1;
pub const EN_LINKCOUNT: i32 = 2;
pub const EN_PATCOUNT: i32 = 3;
pub const EN_CURVECOUNT: i32 = 4;
pub const EN_CONTROLCOUNT: i32 = 5;
pub const EN_RULECOUNT: i32 = 6;

// EN_NodeType
pub const EN_JUNCTION: i32 = 0;
pub const EN_RESERVOIR: i32 = 1;
pub const EN_TANK: i32 = 2;

// EN_Option
pub const EN_TRIALS: i32 = 0;
pub const EN_ACCURACY: i32 = 1;
pub const EN_TOLERANCE: i32 = 2;
pub const EN_EMITEXPON: i32 = 3;
pub const EN_DEMANDMULT: i32 = 4;
pub const EN_HEADERROR: i32 = 5;
pub const EN_FLOWCHANGE: i32 = 6;
pub const EN_HEADLOSSFORM: i32 = 7;
pub const EN_GLOBALEFFIC: i32 = 8;
pub const EN_GLOBALPRICE: i32 = 9;
pub const EN_GLOBALPATTERN: i32 = 10;
pub const EN_DEMANDCHARGE: i32 = 11;
pub const EN_SP_GRAVITY: i32 = 12;
pub const EN_SP_VISCOS: i32 = 13;
pub const EN_UNBALANCED: i32 = 14;
pub const EN_CHECKFREQ: i32 = 15;
pub const EN_MAXCHECK: i32 = 16;
pub const EN_DAMPLIMIT: i32 = 17;
pub const EN_SP_DIFFUS: i32 = 18;
pub const EN_BULKORDER: i32 = 19;
pub const EN_WALLORDER: i32 = 20;
pub const EN_TANKORDER: i32 = 21;
pub const EN_CONCENLIMIT: i32 = 22;
pub const EN_DEMANDPATTERN: i32 = 23;
pub const EN_EMITBACKFLOW: i32 = 24;
pub const EN_PRESS_UNITS: i32 = 25;
pub const EN_STATUS_REPORT: i32 = 26;

// EN_InitHydOption
pub const EN_NOSAVE: i32 = 0;
pub const EN_SAVE: i32 = 1;
pub const EN_INITFLOW: i32 = 10;

// EN_CurveType
pub const EN_VOLUME_CURVE: i32 = 0;
pub const EN_PUMP_CURVE: i32 = 1;
pub const EN_EFFIC_CURVE: i32 = 2;
pub const EN_HLOSS_CURVE: i32 = 3;
pub const EN_GENERIC_CURVE: i32 = 4;
pub const EN_VALVE_CURVE: i32 = 5;

/// `ERRCODE(x)`: keep an error (> 100) once one has happened.
macro_rules! errcode {
    ($e:ident, $x:expr) => {
        if $e <= 100 {
            $e = $x;
        }
    };
}

/// What EPANET keeps of each element that the solver does not need, in solver order
/// (1-based; entry 0 unused): `Comment`, `Tag`, `X`/`Y`, `Vertices`, demand `Name`s.
#[derive(Clone, Debug, Default)]
pub(super) struct Meta {
    pub(super) title: [String; 3],
    pub(super) node_comment: Vec<Option<String>>,
    pub(super) node_tag: Vec<Option<String>>,
    pub(super) node_xy: Vec<Option<(f64, f64)>>,
    pub(super) link_comment: Vec<Option<String>>,
    pub(super) link_tag: Vec<Option<String>>,
    pub(super) link_vertices: Vec<Vec<(f64, f64)>>,
    pub(super) pattern_comment: Vec<Option<String>>,
    pub(super) curve_comment: Vec<Option<String>>,
    /// For each node, the name of each of its demand categories (parallel to `Node::d`).
    pub(super) demand_name: Vec<Vec<Option<String>>>,
    /// `ResultIndex`: an element's position when `inithyd` last numbered them (0 until
    /// then, and for elements added since). It moves with the element.
    pub(super) node_result: Vec<i32>,
    pub(super) link_result: Vec<i32>,
}

/// `xstrcpy`: a copy of at most `n` bytes, or None for an empty string.
pub(super) fn xstrcpy(s: &str, n: usize) -> Option<String> {
    let mut s = s.to_string();
    truncate_bytes(&mut s, n);
    if s.is_empty() { None } else { Some(s) }
}

impl Meta {
    fn from_model(pr: &Project, model: &Model) -> Self {
        let cut = |c: &Option<String>| c.as_deref().and_then(|c| xstrcpy(c, MAXMSG));
        let nodes = || pr.node_order[1..].iter().map(|&mi| &model.nodes[mi]);
        let title = |k: usize| {
            let mut s = model.title.get(k).cloned().unwrap_or_default();
            truncate_bytes(&mut s, TITLELEN);
            s
        };
        Meta {
            title: [title(0), title(1), title(2)],
            node_comment: std::iter::once(None)
                .chain(nodes().map(|n| cut(&n.comment)))
                .collect(),
            node_tag: std::iter::once(None)
                .chain(nodes().map(|n| cut(&n.tag)))
                .collect(),
            node_xy: std::iter::once(None)
                .chain(nodes().map(|n| n.coordinates))
                .collect(),
            link_comment: std::iter::once(None)
                .chain(model.links.iter().map(|l| cut(&l.comment)))
                .collect(),
            link_tag: std::iter::once(None)
                .chain(model.links.iter().map(|l| cut(&l.tag)))
                .collect(),
            link_vertices: std::iter::once(Vec::new())
                .chain(model.links.iter().map(|l| l.vertices.clone()))
                .collect(),
            pattern_comment: std::iter::once(None)
                .chain(model.patterns.iter().map(|p| cut(&p.comment)))
                .collect(),
            curve_comment: std::iter::once(None)
                .chain(model.curves.iter().map(|c| cut(&c.comment)))
                .collect(),
            demand_name: std::iter::once(Vec::new())
                .chain(nodes().map(|n| {
                    match &n.kind {
                        ws_model::NodeKind::Junction(j) => j
                            .demands
                            .iter()
                            .map(|d| d.category.as_deref().and_then(|c| xstrcpy(c, MAXID)))
                            .collect(),
                        _ => Vec::new(),
                    }
                }))
                .collect(),
            node_result: vec![0; pr.net.nnodes + 1],
            link_result: vec![0; pr.net.nlinks + 1],
        }
    }
}

/// An open project: everything EPANET's `Project` holds while `Openflag` is set.
#[derive(Clone, Debug)]
pub(super) struct Open {
    pub(super) pr: Project,
    pub(super) meta: Meta,
    /// `Curve[i].Type` for each curve (1-based; entry 0 unused).
    pub(super) curve_type: Vec<i32>,
    /// `hydraul.OpenHflag`, `quality.OpenQflag`.
    pub(super) open_h: bool,
    pub(super) open_q: bool,
    /// `outfile.SaveHflag`: a complete hydraulic run is in the hydraulics file.
    pub(super) save_h: bool,
    /// `outfile.SaveQflag`: a complete quality run has been saved.
    pub(super) save_q: bool,
    /// `outfile.Saveflag`: results are being saved (to the hydraulics file during a
    /// hydraulic run, to the output file during a quality run).
    pub(super) saveflag: bool,
    /// The hydraulics file and the position `readhyd` reads from next.
    pub(super) hydfile: Vec<HydRecord>,
    pub(super) hyd_next: usize,
    /// The sizes in the hydraulics file's header, as `openhydfile` wrote them.
    pub(super) hyd_sizes: [i32; 6],
    /// `outfile.Hydflag == USE`: the hydraulics come from `hyd_fname`
    /// (`EN_usehydfile`), whose bytes `hyd_raw` keeps.
    pub(super) hyd_use: bool,
    pub(super) hyd_fname: String,
    pub(super) hyd_raw: Option<Vec<u8>>,
    /// `report.Nperiods`.
    pub(super) nperiods: i64,
    /// The input, report and output file names given to `EN_open`.
    pub(super) inp_name: String,
    pub(super) rpt1: String,
    pub(super) out_path: String,
    pub(super) target: report::ReportTarget,
    /// The output file of the quality run saving results.
    pub(super) output: Option<report::Output>,
}

/// An EPANET project (`EN_Project`).
#[derive(Clone, Debug, Default)]
pub struct Toolkit {
    pub(super) p: Option<Box<Open>>,
    /// The report of an `EN_open` that failed, still to be delivered.
    pub(super) pending_failed: Option<(report::ReportTarget, String)>,
}

mod edit;
mod hydfile;
mod inpfile;
mod report;
mod rules;
mod set;

pub use report::ReportOutput;

/// `EN_geterror`'s text for each error code (`errors.dat`); "" for unknown codes.
pub fn errmsg_text(code: i32) -> &'static str {
    match code {
        0 => "ok",
        101 => "insufficient memory available",
        102 => "no network data available",
        103 => "hydraulic solver not opened",
        104 => "no hydraulics for water quality analysis",
        105 => "water quality solver not opened",
        106 => "no results saved to report on",
        107 => "hydraulics supplied from external file",
        108 => "cannot use external file while hydraulics solver is active",
        110 => "cannot solve network hydraulic equations",
        120 => "cannot solve water quality transport equations",
        200 => "one or more errors in input file",
        201 => "syntax error",
        299 => "invalid section keyword",
        202 => "illegal numeric value",
        203 => "undefined node",
        204 => "undefined link",
        205 => "undefined time pattern",
        206 => "undefined curve",
        207 => "attempt to control CV/GPV link",
        208 => "illegal PDA pressure limits",
        209 => "illegal node property value",
        211 => "illegal link property value",
        212 => "undefined trace node",
        213 => "invalid option value",
        214 => "too many characters in input line",
        215 => "duplicate ID label",
        216 => "reference to undefined pump",
        217 => "invalid pump energy data",
        219 => "illegal valve connection to tank node",
        220 => "illegal valve connection to another valve",
        221 => "mis-placed rule clause in rule-based control",
        222 => "same start and end nodes for link",
        223 => "not enough nodes in network",
        224 => "no tanks or reservoirs in network",
        225 => "invalid lower/upper levels for tank",
        226 => "no head curve or power rating for pump",
        227 => "invalid head curve for pump",
        230 => "nonincreasing x-values for curve",
        231 => "no data provided for curve",
        232 => "no data provided for pattern",
        233 => "network has unconnected nodes",
        234 => "network has an unconnected node with ID: ",
        240 => "nonexistent source",
        241 => "nonexistent control",
        250 => "invalid format",
        251 => "invalid parameter code",
        252 => "invalid ID name",
        253 => "nonexistent demand category",
        254 => "node with no coordinates",
        255 => "invalid link vertex",
        257 => "nonexistent rule",
        258 => "nonexistent rule clause",
        259 => "attempt to delete a node that still has links connected to it",
        260 => "attempt to delete node assigned as a Trace Node",
        261 => "attempt to delete a node or link contained in a control",
        262 => "attempt to modify network structure while solver is active",
        263 => "node is not a tank",
        264 => "link is not a valve",
        301 => "identical file names",
        302 => "cannot open input file",
        303 => "cannot open report file",
        304 => "cannot open binary output file",
        305 => "cannot open hydraulics file",
        306 => "hydraulics file does not match network data",
        307 => "cannot read hydraulics file",
        308 => "cannot save results to file",
        309 => "cannot save results to report file",
        _ => "",
    }
}

/// `EN_getversion`
pub fn getversion(version: &mut i32) -> i32 {
    *version = CODEVERSION;
    0
}

/// `EN_geterror`: the message for a code, as C's `snprintf(errmsg, maxLen, ...)` would
/// leave it (at most `max_len - 1` bytes for errors, `max_len` for warnings).
pub fn geterror(errcode: i32, errmsg: &mut String, max_len: i32) -> i32 {
    let max = max_len.max(0) as usize;
    let text = match errcode {
        1 => "WARNING: System hydraulically unbalanced.".to_string(),
        2 => "WARNING: System may be hydraulically unstable.".to_string(),
        3 => "WARNING: System disconnected.".to_string(),
        4 => "WARNING: Pumps cannot deliver enough flow or head.".to_string(),
        5 => "WARNING: Valves cannot deliver enough flow.".to_string(),
        6 => "WARNING: System has negative pressures.".to_string(),
        _ => {
            let mut s = format!("Error {errcode}: ");
            if (202..=222).contains(&errcode) || (240..=261).contains(&errcode) {
                s.push_str("function call contains ");
            }
            s.push_str(errmsg_text(errcode));
            // snprintf keeps max_len - 1 characters and the terminator.
            truncate_bytes(&mut s, max.saturating_sub(1));
            *errmsg = s;
            return if errmsg.is_empty() { 251 } else { 0 };
        }
    };
    let mut s = text;
    truncate_bytes(&mut s, max);
    *errmsg = s;
    if errmsg.is_empty() { 251 } else { 0 }
}

/// Cut a string to at most `n` bytes (at a character boundary).
pub fn truncate_bytes(s: &mut String, n: usize) {
    if s.len() > n {
        let mut k = n;
        while !s.is_char_boundary(k) {
            k -= 1;
        }
        s.truncate(k);
    }
}

/// The curve types EPANET's input stage leaves: a type keyword on the curve's lines,
/// overridden by the uses `tankdata`, `valvedata` and `energydata` find. Pump head
/// curves become pump curves when the hydraulic solver opens (`pumpcurvepump`).
fn curve_types(pr: &Project, model: &Model) -> Vec<i32> {
    let net = &pr.net;
    let mut t: Vec<i32> = std::iter::once(EN_GENERIC_CURVE)
        .chain(model.curves.iter().map(|c| match c.kind {
            Some(ws_model::CurveKind::Volume) => EN_VOLUME_CURVE,
            Some(ws_model::CurveKind::Pump) => EN_PUMP_CURVE,
            Some(ws_model::CurveKind::Efficiency) => EN_EFFIC_CURVE,
            Some(ws_model::CurveKind::Headloss) => EN_HLOSS_CURVE,
            Some(ws_model::CurveKind::Valve) => EN_VALVE_CURVE,
            Some(ws_model::CurveKind::Generic) | None => EN_GENERIC_CURVE,
        }))
        .collect();
    let mut set = |i: usize, v: i32| {
        if i > 0 && i < t.len() {
            t[i] = v;
        }
    };
    for i in 1..=net.ntanks {
        set(net.tank[i].vcurve, EN_VOLUME_CURVE);
    }
    for i in 1..=net.nvalves {
        let k = net.valve[i].link;
        match net.link[k].link_type {
            LinkType::Gpv => set(net.link[k].kc as usize, EN_HLOSS_CURVE),
            LinkType::Pcv => set(net.valve[i].curve, EN_VALVE_CURVE),
            _ => {}
        }
    }
    for i in 1..=net.npumps {
        set(net.pump[i].ecurve, EN_EFFIC_CURVE);
    }
    t
}

impl Open {
    /// The comment of an object, or None when there is no such object.
    pub(super) fn comment_slot(&self, object: i32, index: i32) -> Option<&Option<String>> {
        let net = &self.pr.net;
        let i = usize::try_from(index).ok().filter(|&i| i >= 1)?;
        match object {
            EN_NODE if i <= net.nnodes => self.meta.node_comment.get(i),
            EN_LINK if i <= net.nlinks => self.meta.link_comment.get(i),
            EN_TIMEPAT if i < net.pattern.len() => self.meta.pattern_comment.get(i),
            EN_CURVE if i < net.curve.len() => self.meta.curve_comment.get(i),
            _ => None,
        }
    }
}

impl Toolkit {
    /// `EN_createproject`
    pub fn new() -> Self {
        Toolkit::default()
    }

    pub(super) fn o(&self) -> Option<&Open> {
        self.p.as_deref()
    }

    /// The solver's project, while one is open (for extensions such as EPANET-MSX).
    pub fn project(&self) -> Option<&Project> {
        self.o().map(|o| &o.pr)
    }

    /// `EN_open`, reading the input file's text. Returns EPANET's error code: 200 when
    /// the file has input errors, the validation error otherwise, 0 when it opened.
    pub fn open_text(&mut self, text: &str) -> i32 {
        self.p = None;
        let r = ws_io::read_inp(text);
        if r.errors().next().is_some() {
            return 200;
        }
        self.open_model(r.model)
    }

    /// `EN_open` with a model already read.
    pub fn open_model(&mut self, model: Model) -> i32 {
        self.p = None;
        let pr = match crate::input::build_unvalidated(&model) {
            Ok(pr) => pr,
            Err(e) => return e.code,
        };
        let curve_type = curve_types(&pr, &model);
        let meta = Meta::from_model(&pr, &model);
        self.p = Some(Box::new(Open {
            pr,
            meta,
            curve_type,
            open_h: false,
            open_q: false,
            save_h: false,
            save_q: false,
            saveflag: false,
            hydfile: Vec::new(),
            hyd_next: 0,
            hyd_sizes: [0; 6],
            hyd_use: false,
            hyd_fname: String::new(),
            hyd_raw: None,
            nperiods: 0,
            inp_name: String::new(),
            rpt1: String::new(),
            out_path: String::new(),
            target: report::ReportTarget::None,
            output: None,
        }));
        0
    }

    /// `EN_open`: read an input file.
    pub fn open(&mut self, inp_file: &str) -> i32 {
        self.p = None;
        let code = match std::fs::read(inp_file) {
            Ok(bytes) => self.open_text(&String::from_utf8_lossy(&bytes)),
            Err(_) => 302,
        };
        if let Some(o) = self.p.as_deref_mut() {
            o.inp_name = inp_file.to_string();
        }
        code
    }

    /// `EN_close`
    pub fn close(&mut self) -> i32 {
        self.p = None;
        0
    }

    pub fn is_open(&self) -> bool {
        self.p.is_some()
    }

    /// `EN_gettitle`
    pub fn gettitle(&self, line1: &mut String, line2: &mut String, line3: &mut String) -> i32 {
        let Some(o) = self.o() else { return 102 };
        *line1 = o.meta.title[0].clone();
        *line2 = o.meta.title[1].clone();
        *line3 = o.meta.title[2].clone();
        0
    }

    /// `EN_getcomment` (`getcomment`)
    pub fn getcomment(&self, object: i32, index: i32, comment: &mut String) -> i32 {
        comment.clear();
        let Some(o) = self.o() else {
            // getcomment reads the network without checking Openflag; an unopened
            // project has no objects.
            return 251;
        };
        match o.comment_slot(object, index) {
            Some(Some(c)) => comment.push_str(c),
            Some(None) => {}
            None => return 251,
        }
        0
    }

    /// `EN_gettag` (`gettag`)
    pub fn gettag(&self, object: i32, index: i32, tag: &mut String) -> i32 {
        tag.clear();
        let Some(o) = self.o() else { return 251 };
        let net = &o.pr.net;
        let i = index as usize;
        let t = match object {
            EN_NODE if index >= 1 && i <= net.nnodes => &o.meta.node_tag[i],
            EN_LINK if index >= 1 && i <= net.nlinks => &o.meta.link_tag[i],
            _ => return 251,
        };
        if let Some(t) = t {
            tag.push_str(t);
        }
        0
    }

    /// `EN_getcount`
    pub fn getcount(&self, object: i32, count: &mut i32) -> i32 {
        *count = 0;
        let Some(o) = self.o() else { return 102 };
        let net = &o.pr.net;
        *count = match object {
            EN_NODECOUNT => net.nnodes as i32,
            EN_TANKCOUNT => net.ntanks as i32,
            EN_LINKCOUNT => net.nlinks as i32,
            EN_PATCOUNT => (net.pattern.len() - 1) as i32,
            EN_CURVECOUNT => (net.curve.len() - 1) as i32,
            EN_CONTROLCOUNT => net.ncontrols as i32,
            EN_RULECOUNT => o.pr.rules.len() as i32,
            _ => return 251,
        };
        0
    }

    // ---- Hydraulic analysis ----------------------------------------------------------

    /// `EN_solveH`
    pub fn solve_h(&mut self) -> i32 {
        let mut errcode = self.open_h();
        if errcode == 0 {
            errcode = self.init_h(EN_SAVE);
            if errcode == 0 {
                loop {
                    let mut t = 0;
                    let mut tstep = 0;
                    errcode!(errcode, self.run_h(&mut t));
                    errcode!(errcode, self.next_h(&mut tstep));
                    if tstep <= 0 {
                        break;
                    }
                }
            }
        }
        self.close_h();
        let warn = self.o().map_or(0, |o| o.pr.warnflag);
        errcode.max(warn)
    }

    /// `EN_openH`
    pub fn open_h(&mut self) -> i32 {
        let Some(o) = self.p.as_deref_mut() else {
            return 102;
        };
        o.open_h = false;
        o.save_h = false;
        if o.hyd_use {
            return 107;
        }
        // openhyd validates first: 223 and 224 as such, anything else as 110. Pump
        // head curves are typed as validatepumps processes them.
        if o.pr.net.nnodes >= 2 && o.pr.net.ntanks > 0 {
            for i in 1..=o.pr.net.npumps {
                let c = o.pr.net.pump[i].hcurve;
                if c > 0 && c < o.curve_type.len() {
                    o.curve_type[c] = EN_PUMP_CURVE;
                }
            }
        }
        if let Err(e) = crate::input::validateproject(&mut o.pr) {
            let code = if e.code == 223 || e.code == 224 {
                e.code
            } else {
                110
            };
            o.errmsg(code);
            return code;
        }
        match hydraul::openhyd(&mut o.pr) {
            Ok(()) => {
                // createsparse leaves fresh adjacency lists for the quality solver.
                o.pr.adjlist = quality::buildadjlists(&o.pr.net);
                o.open_h = true;
                crate::report::writetime(&mut o.pr, "begun");
                0
            }
            Err(e) => {
                o.errmsg(e.code);
                e.code
            }
        }
    }

    /// `EN_initH`
    pub fn init_h(&mut self, init_flag: i32) -> i32 {
        let Some(o) = self.p.as_deref_mut() else {
            return 103;
        };
        o.save_h = false;
        o.pr.warnflag = 0;
        let fflag = init_flag / EN_INITFLOW;
        let sflag = init_flag - fflag * EN_INITFLOW;
        if !o.open_h {
            return 103;
        }
        o.saveflag = false;
        if sflag > 0 {
            // openhydfile: a fresh scratch file.
            o.hydfile.clear();
            o.hyd_next = 0;
            o.hyd_sizes = quality::hydfile_sizes(&o.pr);
            o.hyd_raw = None;
            o.saveflag = true;
        }
        leakage::openleakage(&mut o.pr);
        hydraul::inithyd(&mut o.pr, fflag > 0);
        if o.pr.rpt.statflag != crate::report::Statflag::No && crate::report::writing(&o.pr) {
            crate::report::writeheader(&mut o.pr, crate::report::Header::Status, false);
        }
        for (i, r) in o.meta.node_result.iter_mut().enumerate() {
            *r = i as i32;
        }
        for (k, r) in o.meta.link_result.iter_mut().enumerate() {
            *r = k as i32;
        }
        0
    }

    /// `EN_runH`
    pub fn run_h(&mut self, current_time: &mut i64) -> i32 {
        *current_time = 0;
        let Some(o) = self.p.as_deref_mut() else {
            return 103;
        };
        if !o.open_h {
            return 103;
        }
        *current_time = o.pr.times.htime;
        match hydraul::runhyd(&mut o.pr) {
            Ok((_, _, warn)) => warn,
            Err(e) => {
                o.errmsg(e.code);
                e.code
            }
        }
    }

    /// `EN_nextH`
    pub fn next_h(&mut self, t_step: &mut i64) -> i32 {
        *t_step = 0;
        let Some(o) = self.p.as_deref_mut() else {
            return 103;
        };
        if !o.open_h {
            return 103;
        }
        if o.saveflag {
            // nexthyd saves the solution before it moves on, then the step.
            let mut r = quality::savehyd(&o.pr, o.pr.times.htime);
            *t_step = hydraul::nexthyd(&mut o.pr);
            r.hydstep = *t_step;
            o.hydfile.push(r);
        } else {
            *t_step = hydraul::nexthyd(&mut o.pr);
        }
        if o.saveflag && *t_step == 0 {
            o.save_h = true;
        }
        0
    }

    /// `EN_closeH`
    pub fn close_h(&mut self) -> i32 {
        let Some(o) = self.p.as_deref_mut() else {
            return 102;
        };
        o.open_h = false;
        0
    }

    // ---- Water quality analysis ------------------------------------------------------

    /// `EN_solveQ`
    pub fn solve_q(&mut self) -> i32 {
        let mut errcode = self.open_q();
        if errcode == 0 {
            errcode = self.init_q(EN_SAVE);
            if errcode == 0 {
                loop {
                    let mut t = 0;
                    let mut tstep = 0;
                    errcode!(errcode, self.run_q(&mut t));
                    errcode!(errcode, self.next_q(&mut tstep));
                    if tstep <= 0 {
                        break;
                    }
                }
            }
        }
        self.close_q();
        errcode
    }

    /// `EN_openQ`
    pub fn open_q(&mut self) -> i32 {
        let Some(o) = self.p.as_deref_mut() else {
            return 102;
        };
        o.open_q = false;
        o.pr.qual.open_q = false;
        o.save_q = false;
        if !o.open_h && !o.save_h {
            return 104;
        }
        o.pr.adjlist = quality::buildadjlists(&o.pr.net);
        match quality::openqual(&mut o.pr) {
            Ok(()) => {
                o.open_q = true;
                o.pr.qual.open_q = true;
                0
            }
            Err(c) => {
                o.errmsg(c);
                c
            }
        }
    }

    /// `EN_initQ`
    pub fn init_q(&mut self, save_flag: i32) -> i32 {
        let Some(o) = self.p.as_deref_mut() else {
            return 105;
        };
        if !o.open_q {
            return 105;
        }
        // initqual re-positions the hydraulics file when reading from it.
        if !o.open_h {
            o.hyd_next = 0;
        }
        quality::initqual(&mut o.pr);
        o.nperiods = 0;
        o.save_q = false;
        o.saveflag = save_flag != 0;
        if o.saveflag {
            Self::open_output(o);
        }
        0
    }

    /// `runqual`: the hydraulics for the current time and the results to save.
    fn runqual(o: &mut Open, t: &mut i64) -> i32 {
        *t = o.pr.times.qtime;
        if o.pr.times.qtime == o.pr.times.htime {
            let mut next_htime = None;
            if !o.open_h {
                let Some(r) = o.hydfile.get(o.hyd_next) else {
                    return 307;
                };
                o.hyd_next += 1;
                quality::readhyd(&mut o.pr, r);
                o.pr.times.htime = r.htime;
                next_htime = Some(r.htime + r.hydstep);
            }
            if o.pr.times.htime >= o.pr.times.rtime {
                if o.saveflag {
                    Self::save_output(o);
                    o.nperiods += 1;
                }
                o.pr.times.rtime += o.pr.times.rstep;
            }
            if let Err(c) = quality::runqual_update(&mut o.pr) {
                return c;
            }
            if let Some(h) = next_htime {
                o.pr.times.htime = h;
            }
        }
        0
    }

    /// `EN_runQ`
    pub fn run_q(&mut self, current_time: &mut i64) -> i32 {
        *current_time = 0;
        let Some(o) = self.p.as_deref_mut() else {
            return 105;
        };
        if !o.open_q {
            return 105;
        }
        Self::runqual(o, current_time)
    }

    /// `EN_nextQ`
    pub fn next_q(&mut self, t_step: &mut i64) -> i32 {
        *t_step = 0;
        let Some(o) = self.p.as_deref_mut() else {
            return 105;
        };
        if !o.open_q {
            return 105;
        }
        *t_step = quality::nextqual(&mut o.pr);
        if o.saveflag && *t_step == 0 {
            o.save_q = true;
            return Self::finish_output(o);
        }
        0
    }

    /// `EN_stepQ` (`stepqual`)
    pub fn step_q(&mut self, time_left: &mut i64) -> i32 {
        *time_left = 0;
        let Some(o) = self.p.as_deref_mut() else {
            return 105;
        };
        if !o.open_q {
            return 105;
        }
        let mut errcode = 0;
        let mut tstep = o.pr.times.qstep;
        loop {
            let mut dt = tstep;
            let hstep = o.pr.times.htime - o.pr.times.qtime;
            if hstep < dt {
                dt = hstep;
                if o.pr.qual.qualflag != QualType::None {
                    quality::transport(&mut o.pr, dt);
                }
                o.pr.times.qtime += dt;
                if o.open_h {
                    break;
                }
                let mut t = 0;
                errcode = Self::runqual(o, &mut t);
                o.pr.times.qtime = t;
            } else {
                if o.pr.qual.qualflag != QualType::None {
                    quality::transport(&mut o.pr, dt);
                }
                o.pr.times.qtime += dt;
            }
            tstep -= dt;
            if errcode != 0 || tstep <= 0 {
                break;
            }
        }
        quality::evalmassbalance(&mut o.pr);
        *time_left = o.pr.times.dur - o.pr.times.qtime;
        if errcode == 0 && *time_left == 0 && o.saveflag {
            o.save_q = true;
            errcode = Self::finish_output(o);
        }
        if errcode != 0 {
            o.errmsg(errcode);
        }
        errcode
    }

    /// `EN_closeQ`
    pub fn close_q(&mut self) -> i32 {
        let Some(o) = self.p.as_deref_mut() else {
            return 102;
        };
        quality::closequal(&mut o.pr);
        o.open_q = false;
        o.pr.qual.open_q = false;
        crate::report::writetime(&mut o.pr, "ended");
        0
    }

    // ---- Statistics and options ------------------------------------------------------

    /// `EN_getstatistic`
    pub fn getstatistic(&self, kind: i32, value: &mut f64) -> i32 {
        // EPANET reads the (zeroed) project even when nothing is open.
        let default = Project::default();
        let pr = self.o().map_or(&default, |o| &o.pr);
        let hyd = &pr.hyd;
        let ucf = &pr.units.ucf;
        *value = match kind {
            EN_ITERATIONS => f64::from(hyd.iterations),
            EN_RELATIVEERROR => hyd.relative_error,
            EN_MAXHEADERROR => hyd.max_head_error * ucf[Field::Head as usize],
            EN_MAXFLOWCHANGE => hyd.max_flow_change * ucf[Field::Flow as usize],
            EN_DEFICIENTNODES => f64::from(hyd.deficient_nodes),
            EN_DEMANDREDUCTION => hyd.demand_reduction,
            EN_LEAKAGELOSS => hyd.leakage_loss,
            EN_MASSBALANCE => pr.qual.mass.ratio,
            _ => {
                *value = 0.0;
                return 251;
            }
        };
        0
    }

    /// `EN_getresultindex`
    pub fn getresultindex(&self, kind: i32, index: i32, value: &mut i32) -> i32 {
        *value = 0;
        let Some(o) = self.o() else { return 102 };
        let net = &o.pr.net;
        if kind == EN_NODE {
            if index <= 0 || index as usize > net.nnodes {
                return 203;
            }
        } else if kind == EN_LINK {
            if index <= 0 || index as usize > net.nlinks {
                return 204;
            }
        } else {
            return 251;
        }
        *value = if kind == EN_NODE {
            o.meta.node_result[index as usize]
        } else {
            o.meta.link_result[index as usize]
        };
        0
    }

    /// `EN_getoption`
    pub fn getoption(&self, option: i32, value: &mut f64) -> i32 {
        *value = 0.0;
        let Some(o) = self.o() else { return 102 };
        let pr = &o.pr;
        let hyd = &pr.hyd;
        let qual = &pr.qual;
        let ucf = &pr.units.ucf;
        let v = match option {
            EN_TRIALS => f64::from(hyd.max_iter),
            EN_ACCURACY => hyd.hacc,
            EN_TOLERANCE => qual.ctol * ucf[Field::Quality as usize],
            EN_EMITEXPON => {
                if hyd.qexp > 0.0 {
                    1.0 / hyd.qexp
                } else {
                    0.0
                }
            }
            EN_DEMANDMULT => hyd.dmult,
            EN_HEADERROR => hyd.head_error_limit * ucf[Field::Head as usize],
            EN_FLOWCHANGE => hyd.flow_change_limit * ucf[Field::Flow as usize],
            EN_HEADLOSSFORM => hyd.formflag as i32 as f64,
            EN_GLOBALEFFIC => hyd.epump,
            EN_GLOBALPRICE => hyd.ecost,
            EN_GLOBALPATTERN => hyd.epat as f64,
            EN_DEMANDCHARGE => hyd.dcost,
            EN_SP_GRAVITY => hyd.sp_grav,
            EN_SP_VISCOS => hyd.viscos / VISCOS,
            EN_UNBALANCED => f64::from(hyd.extra_iter),
            EN_CHECKFREQ => f64::from(hyd.check_freq),
            EN_MAXCHECK => f64::from(hyd.max_check),
            EN_DAMPLIMIT => hyd.damp_limit,
            EN_SP_DIFFUS => qual.diffus / DIFFUS,
            EN_BULKORDER => qual.bulk_order,
            EN_WALLORDER => qual.wall_order,
            EN_TANKORDER => qual.tank_order,
            EN_CONCENLIMIT => qual.climit * ucf[Field::Quality as usize],
            EN_DEMANDPATTERN => hyd.def_pat as f64,
            EN_EMITBACKFLOW => f64::from(u8::from(hyd.emit_back_flag)),
            EN_PRESS_UNITS => pr.units.pressflag as i32 as f64,
            EN_STATUS_REPORT => pr.rpt.statflag as i32 as f64,
            _ => return 251,
        };
        *value = v;
        0
    }

    /// `EN_getflowunits`
    pub fn getflowunits(&self, units: &mut i32) -> i32 {
        *units = -1;
        let Some(o) = self.o() else { return 102 };
        *units = o.pr.units.flowflag as i32;
        0
    }

    /// `EN_gettimeparam`
    pub fn gettimeparam(&self, param: i32, value: &mut i64) -> i32 {
        *value = 0;
        let Some(o) = self.o() else { return 102 };
        if !(EN_DURATION..=EN_NEXTEVENTTANK).contains(&param) {
            return 251;
        }
        let t = &o.pr.times;
        match param {
            EN_DURATION => *value = t.dur,
            EN_HYDSTEP => *value = t.hstep,
            EN_QUALSTEP => *value = t.qstep,
            EN_PATTERNSTEP => *value = t.pstep,
            EN_PATTERNSTART => *value = t.pstart,
            EN_REPORTSTEP => *value = t.rstep,
            EN_REPORTSTART => *value = t.rstart,
            EN_RULESTEP => *value = t.rulestep,
            EN_STATISTIC => *value = o.pr.rpt.tstatflag as i64,
            EN_PERIODS => *value = o.nperiods,
            EN_STARTTIME => *value = t.tstart,
            EN_HTIME => *value = t.htime,
            EN_QTIME => *value = t.qtime,
            EN_HALTFLAG => {}
            EN_NEXTEVENT => {
                *value = t.hstep;
                hydraul::tanktimestep(&o.pr, value);
            }
            EN_NEXTEVENTTANK => {
                *value = t.hstep;
                *value = hydraul::tanktimestep(&o.pr, value) as i64;
            }
            _ => return 251,
        }
        0
    }

    /// `EN_timetonextevent`
    pub fn timetonextevent(
        &self,
        event_type: &mut i32,
        duration: &mut i64,
        element_index: &mut i32,
    ) -> i32 {
        let Some(o) = self.o() else {
            *event_type = EN_STEP_HYD;
            *duration = 0;
            *element_index = 0;
            return 0;
        };
        let hyd_step = o.pr.times.hstep;
        let mut tank_step = hyd_step;
        let mut control_step = hyd_step;
        let i_tank = hydraul::tanktimestep(&o.pr, &mut tank_step);
        let i_control = hydraul::controltimestep(&o.pr, &mut control_step);
        if control_step < tank_step {
            *event_type = EN_STEP_CONTROLEVENT;
            *duration = control_step;
            *element_index = i_control as i32;
        } else if tank_step < hyd_step {
            *event_type = EN_STEP_TANKEVENT;
            *duration = tank_step;
            *element_index = i_tank as i32;
        } else {
            *event_type = EN_STEP_HYD;
            *duration = hyd_step;
            *element_index = 0;
        }
        0
    }

    /// `EN_getqualinfo`
    pub fn getqualinfo(
        &self,
        qual_type: &mut i32,
        chem_name: &mut String,
        chem_units: &mut String,
        trace_node: &mut i32,
    ) -> i32 {
        self.getqualtype(qual_type, trace_node);
        let Some(o) = self.o() else { return 0 };
        let q = &o.pr.qual;
        let (name, units) = match q.qualflag {
            QualType::Chem => (q.chem_name.as_str(), q.chem_units.as_str()),
            QualType::Trace => ("TRACE", "% from"),
            QualType::Age => ("AGE", "hrs"),
            QualType::None => ("", ""),
        };
        *chem_name = name.to_string();
        truncate_bytes(chem_name, MAXID);
        *chem_units = units.to_string();
        truncate_bytes(chem_units, MAXID);
        0
    }

    /// `EN_getqualtype`
    pub fn getqualtype(&self, qual_type: &mut i32, trace_node: &mut i32) -> i32 {
        *trace_node = 0;
        let Some(o) = self.o() else { return 102 };
        *qual_type = o.pr.qual.qualflag as i32;
        if o.pr.qual.qualflag == QualType::Trace {
            *trace_node = o.pr.qual.trace_node as i32;
        }
        0
    }

    // ---- Nodes -----------------------------------------------------------------------

    /// `findnode`
    pub(super) fn findnode(o: &Open, id: &str) -> usize {
        (1..=o.pr.net.nnodes)
            .find(|&i| o.pr.net.node[i].id == id)
            .unwrap_or(0)
    }

    /// `findlink`
    pub(super) fn findlink(o: &Open, id: &str) -> usize {
        (1..=o.pr.net.nlinks)
            .find(|&i| o.pr.net.link[i].id == id)
            .unwrap_or(0)
    }

    /// `EN_getnodeindex`
    pub fn getnodeindex(&self, id: &str, index: &mut i32) -> i32 {
        *index = 0;
        let Some(o) = self.o() else { return 102 };
        *index = Self::findnode(o, id) as i32;
        if *index == 0 { 203 } else { 0 }
    }

    /// `EN_getnodeid`
    pub fn getnodeid(&self, index: i32, id: &mut String) -> i32 {
        id.clear();
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > o.pr.net.nnodes {
            return 203;
        }
        id.push_str(&o.pr.net.node[index as usize].id);
        0
    }

    /// `EN_getnodetype`
    pub fn getnodetype(&self, index: i32, node_type: &mut i32) -> i32 {
        *node_type = -1;
        let Some(o) = self.o() else { return 102 };
        let net = &o.pr.net;
        if index < 1 || index as usize > net.nnodes {
            return 203;
        }
        let i = index as usize;
        *node_type = if i <= net.njuncs {
            EN_JUNCTION
        } else if net.tank[i - net.njuncs].a == 0.0 {
            EN_RESERVOIR
        } else {
            EN_TANK
        };
        0
    }

    /// `incontrols` (project.c): whether a simple or rule-based control names an element.
    pub(super) fn incontrols(pr: &Project, node: bool, index: usize) -> bool {
        let net = &pr.net;
        for i in 1..=net.ncontrols {
            if node && net.control[i].node == index {
                return true;
            }
            if !node && net.control[i].link == index {
                return true;
            }
        }
        pr.rules.iter().any(|r| r.names(node, index))
    }

    /// `EN_getnodevalue`
    pub fn getnodevalue(&self, index: i32, property: i32, value: &mut f64) -> i32 {
        *value = 0.0;
        let Some(o) = self.o() else { return 102 };
        let pr = &o.pr;
        let net = &pr.net;
        let hyd = &pr.hyd;
        if index <= 0 || index as usize > net.nnodes {
            return 203;
        }
        let i = index as usize;
        let njuncs = net.njuncs;
        let ucf = |f: Field| pr.units.ucf[f as usize];
        let node = &net.node[i];
        let tank = || &net.tank[i - njuncs];
        let at = |v: &Vec<f64>| v.get(i).copied().unwrap_or(0.0);
        let v = match property {
            EN_ELEVATION => node.el * ucf(Field::Elev),
            EN_BASEDEMAND => {
                if i <= njuncs {
                    node.d.first().map_or(0.0, |d| d.base * ucf(Field::Flow))
                } else {
                    0.0
                }
            }
            EN_PATTERN => {
                if i <= njuncs {
                    node.d.first().map_or(0.0, |d| d.pat as f64)
                } else {
                    tank().pat as f64
                }
            }
            EN_EMITTER => {
                if node.ke > 0.0 {
                    let ecf = if pr.units.unitsflag == UnitsType::Us {
                        PSI_PER_FT * hyd.sp_grav
                    } else {
                        M_PER_FT
                    };
                    ucf(Field::Flow) / pow(ecf * node.ke, 1.0 / hyd.qexp)
                } else {
                    0.0
                }
            }
            EN_INITQUAL => node.c0 * ucf(Field::Quality),
            EN_SOURCEQUAL | EN_SOURCETYPE | EN_SOURCEMASS | EN_SOURCEPAT => {
                let Some(s) = &node.source else { return 240 };
                match property {
                    EN_SOURCEQUAL => s.c0,
                    EN_SOURCEMASS => s.smass * 60.0,
                    EN_SOURCEPAT => s.pat as f64,
                    _ => s.kind as i32 as f64,
                }
            }
            EN_TANKLEVEL => {
                if i <= njuncs {
                    return 0;
                }
                (tank().h0 - node.el) * ucf(Field::Elev)
            }
            EN_INITVOLUME => {
                if i > njuncs {
                    tank().v0 * ucf(Field::Volume)
                } else {
                    0.0
                }
            }
            EN_MIXMODEL => {
                if i > njuncs {
                    tank().mix_model as i32 as f64
                } else {
                    0.0
                }
            }
            EN_MIXZONEVOL => {
                if i > njuncs {
                    tank().v1frac * tank().vmax * ucf(Field::Volume)
                } else {
                    0.0
                }
            }
            EN_DEMAND => at(&hyd.node_demand) * ucf(Field::Flow),
            EN_HEAD => at(&hyd.node_head) * ucf(Field::Head),
            EN_PRESSURE => (at(&hyd.node_head) - node.el) * ucf(Field::Pressure),
            EN_QUALITY => at(&pr.qual.node_qual) * ucf(Field::Quality),
            EN_TANKDIAM => {
                if i > njuncs {
                    sqrt(4.0 / PI * tank().a) * ucf(Field::Elev)
                } else {
                    0.0
                }
            }
            EN_MINVOLUME => {
                if i > njuncs {
                    tank().vmin * ucf(Field::Volume)
                } else {
                    0.0
                }
            }
            EN_MAXVOLUME => {
                if i > njuncs {
                    tank().vmax * ucf(Field::Volume)
                } else {
                    0.0
                }
            }
            EN_VOLCURVE => {
                if i > njuncs {
                    tank().vcurve as f64
                } else {
                    0.0
                }
            }
            EN_MINLEVEL => {
                if i > njuncs {
                    (tank().hmin - node.el) * ucf(Field::Elev)
                } else {
                    0.0
                }
            }
            EN_MAXLEVEL => {
                if i > njuncs {
                    (tank().hmax - node.el) * ucf(Field::Elev)
                } else {
                    0.0
                }
            }
            EN_MIXFRACTION => {
                if i > njuncs {
                    tank().v1frac
                } else {
                    1.0
                }
            }
            EN_TANK_KBULK => {
                if i > njuncs {
                    tank().kb * SECPERDAY_F
                } else {
                    0.0
                }
            }
            EN_TANKVOLUME => {
                if i <= njuncs {
                    return 0;
                }
                hydraul::tankvolume(pr, i - njuncs, at(&hyd.node_head)) * ucf(Field::Volume)
            }
            EN_CANOVERFLOW => {
                if node.node_type != NodeType::Tank {
                    return 0;
                }
                f64::from(u8::from(tank().can_overflow))
            }
            EN_DEMANDDEFICIT => {
                if i > njuncs {
                    return 0;
                }
                let full = at(&hyd.full_demand);
                if full <= 0.0 {
                    return 0;
                }
                let v = (full - at(&hyd.demand_flow)) * ucf(Field::Flow);
                if v < 0.0 { 0.0 } else { v }
            }
            EN_NODE_INCONTROL => f64::from(u8::from(Self::incontrols(pr, true, i))),
            EN_EMITTERFLOW => at(&hyd.emitter_flow) * ucf(Field::Flow),
            EN_LEAKAGEFLOW => at(&hyd.leakage_flow) * ucf(Field::Flow),
            EN_DEMANDFLOW => at(&hyd.demand_flow) * ucf(Field::Flow),
            EN_FULLDEMAND => at(&hyd.full_demand) * ucf(Field::Flow),
            _ => return 251,
        };
        *value = v;
        0
    }

    /// `EN_getnodevalues`
    pub fn getnodevalues(&self, property: i32, values: &mut [f64]) -> i32 {
        let n = self.o().map_or(0, |o| o.pr.net.nnodes);
        for i in 1..=n {
            let Some(slot) = values.get_mut(i - 1) else {
                return 251;
            };
            let e = self.getnodevalue(i as i32, property, slot);
            if e != 0 {
                return e;
            }
        }
        0
    }

    /// `EN_getcoord`
    pub fn getcoord(&self, index: i32, x: &mut f64, y: &mut f64) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > o.pr.net.nnodes {
            return 203;
        }
        match o.meta.node_xy[index as usize] {
            Some((cx, cy)) => {
                *x = cx;
                *y = cy;
                0
            }
            None => 254,
        }
    }

    // ---- Demands ---------------------------------------------------------------------

    /// `EN_getdemandmodel`
    pub fn getdemandmodel(
        &self,
        model: &mut i32,
        pmin: &mut f64,
        preq: &mut f64,
        pexp: &mut f64,
    ) -> i32 {
        let default = Project::default();
        let pr = self.o().map_or(&default, |o| &o.pr);
        let ucf = pr.units.ucf[Field::Pressure as usize];
        *model = pr.hyd.demand_model as i32;
        *pmin = pr.hyd.pmin * ucf;
        *preq = pr.hyd.preq * ucf;
        *pexp = pr.hyd.pexp;
        0
    }

    /// `EN_getnumdemands`
    pub fn getnumdemands(&self, node_index: i32, num_demands: &mut i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if node_index <= 0 || node_index as usize > o.pr.net.nnodes {
            return 203;
        }
        *num_demands = o.pr.net.node[node_index as usize].d.len() as i32;
        0
    }

    /// `EN_getbasedemand`
    pub fn getbasedemand(&self, node_index: i32, demand_index: i32, base_demand: &mut f64) -> i32 {
        *base_demand = 0.0;
        let Some(o) = self.o() else { return 102 };
        if node_index <= 0 || node_index as usize > o.pr.net.nnodes {
            return 203;
        }
        let d = &o.pr.net.node[node_index as usize].d;
        if demand_index < 1 || demand_index as usize > d.len() {
            return 253;
        }
        *base_demand = d[demand_index as usize - 1].base * o.pr.units.ucf[Field::Flow as usize];
        0
    }

    /// `EN_getdemandname`
    pub fn getdemandname(
        &self,
        node_index: i32,
        demand_index: i32,
        demand_name: &mut String,
    ) -> i32 {
        demand_name.clear();
        let Some(o) = self.o() else { return 102 };
        if node_index <= 0 || node_index as usize > o.pr.net.njuncs {
            return 203;
        }
        let i = node_index as usize;
        let d = &o.pr.net.node[i].d;
        if demand_index < 1 || demand_index as usize > d.len() {
            return 253;
        }
        if let Some(Some(name)) = o.meta.demand_name[i].get(demand_index as usize - 1) {
            demand_name.push_str(name);
        }
        0
    }

    /// `EN_getdemandpattern`
    pub fn getdemandpattern(&self, node_index: i32, demand_index: i32, pat_index: &mut i32) -> i32 {
        *pat_index = 0;
        let Some(o) = self.o() else { return 102 };
        if node_index <= 0 || node_index as usize > o.pr.net.nnodes {
            return 203;
        }
        let d = &o.pr.net.node[node_index as usize].d;
        if demand_index < 1 || demand_index as usize > d.len() {
            return 253;
        }
        *pat_index = d[demand_index as usize - 1].pat as i32;
        0
    }

    /// `EN_getdemandindex`
    pub fn getdemandindex(
        &self,
        node_index: i32,
        demand_name: &str,
        demand_index: &mut i32,
    ) -> i32 {
        *demand_index = 0;
        let Some(o) = self.o() else { return 102 };
        if node_index <= 0 || node_index as usize > o.pr.net.nnodes {
            return 203;
        }
        let i = node_index as usize;
        let names = &o.meta.demand_name[i];
        let empty = demand_name.is_empty();
        for n in 1..=o.pr.net.node[i].d.len() {
            let found = match names.get(n - 1).and_then(Option::as_deref) {
                None => empty,
                Some(s) => s == demand_name,
            };
            if found {
                *demand_index = n as i32;
                return 0;
            }
        }
        253
    }

    // ---- Links -----------------------------------------------------------------------

    /// `EN_getlinkindex`
    pub fn getlinkindex(&self, id: &str, index: &mut i32) -> i32 {
        *index = 0;
        let Some(o) = self.o() else { return 102 };
        *index = Self::findlink(o, id) as i32;
        if *index == 0 { 204 } else { 0 }
    }

    /// `EN_getlinkid`
    pub fn getlinkid(&self, index: i32, id: &mut String) -> i32 {
        id.clear();
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        id.push_str(&o.pr.net.link[index as usize].id);
        0
    }

    /// `EN_getlinktype`
    pub fn getlinktype(&self, index: i32, link_type: &mut i32) -> i32 {
        *link_type = -1;
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        *link_type = o.pr.net.link[index as usize].link_type as i32;
        0
    }

    /// `EN_getlinknodes`
    pub fn getlinknodes(&self, index: i32, node1: &mut i32, node2: &mut i32) -> i32 {
        *node1 = 0;
        *node2 = 0;
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        let l = &o.pr.net.link[index as usize];
        *node1 = l.n1 as i32;
        *node2 = l.n2 as i32;
        0
    }

    /// `EN_getlinkvalue`
    pub fn getlinkvalue(&self, index: i32, property: i32, value: &mut f64) -> i32 {
        *value = 0.0;
        let Some(o) = self.o() else { return 102 };
        let pr = &o.pr;
        let net = &pr.net;
        let hyd = &pr.hyd;
        if index <= 0 || index as usize > net.nlinks {
            return 204;
        }
        let i = index as usize;
        let link = &net.link[i];
        let ucf = |f: Field| pr.units.ucf[f as usize];
        let status = hyd.link_status.get(i).copied().unwrap_or(Status::XHead);
        let flow = hyd.link_flow.get(i).copied().unwrap_or(0.0);
        let setting = hyd.link_setting.get(i).copied().unwrap_or(0.0);
        let head = |n: usize| hyd.node_head.get(n).copied().unwrap_or(0.0);
        let pump = || &net.pump[net.findpump(i)];
        let v = match property {
            EN_DIAMETER => {
                if link.link_type == LinkType::Pump {
                    0.0
                } else {
                    link.diam * ucf(Field::Diam)
                }
            }
            EN_LENGTH => link.len * ucf(Field::Elev),
            EN_ROUGHNESS | EN_SETTING
                if property == EN_ROUGHNESS || link.link_type <= LinkType::Pipe =>
            {
                if link.link_type <= LinkType::Pipe {
                    if hyd.formflag == Formula::Dw {
                        link.kc * (1000.0 * ucf(Field::Elev))
                    } else {
                        link.kc
                    }
                } else {
                    0.0
                }
            }
            EN_MINORLOSS => {
                if link.link_type != LinkType::Pump {
                    let mut v = link.km;
                    v *= link.diam * link.diam * (link.diam * link.diam) / 0.02517;
                    v
                } else {
                    0.0
                }
            }
            EN_INITSTATUS => {
                let mut v = if link.init_status <= Status::Closed {
                    0.0
                } else {
                    1.0
                };
                if link.link_type > LinkType::Pump && link.init_status > Status::Open {
                    v = 2.0;
                }
                v
            }
            EN_INITSETTING => {
                let mut v = link.init_setting;
                match link.link_type {
                    LinkType::CvPipe | LinkType::Pipe => {
                        if hyd.formflag == Formula::Dw {
                            v *= 1000.0 * ucf(Field::Elev);
                        }
                    }
                    LinkType::Prv | LinkType::Psv | LinkType::Pbv => v *= ucf(Field::Pressure),
                    LinkType::Fcv => v *= ucf(Field::Flow),
                    _ => {}
                }
                v
            }
            EN_KBULK => link.kb * SECPERDAY_F,
            EN_KWALL => link.kw * SECPERDAY_F,
            EN_FLOW => {
                if status <= Status::Closed {
                    0.0
                } else {
                    flow * ucf(Field::Flow)
                }
            }
            EN_VELOCITY => {
                if link.link_type == LinkType::Pump || status <= Status::Closed {
                    0.0
                } else {
                    let q = abs(flow);
                    let a = PI * (link.diam * link.diam) / 4.0;
                    q / a * ucf(Field::Velocity)
                }
            }
            EN_HEADLOSS => {
                if status <= Status::Closed {
                    0.0
                } else {
                    let mut h = head(link.n1) - head(link.n2);
                    if link.link_type != LinkType::Pump {
                        h = abs(h);
                    }
                    h * ucf(Field::Headloss)
                }
            }
            EN_STATUS => {
                let mut v = if status <= Status::Closed { 0.0 } else { 1.0 };
                if link.link_type > LinkType::Pump && status > Status::Open {
                    v = 2.0;
                }
                v
            }
            EN_SETTING => {
                let mut v = if setting == MISSING { 0.0 } else { setting };
                match link.link_type {
                    LinkType::Prv | LinkType::Psv | LinkType::Pbv => v *= ucf(Field::Pressure),
                    LinkType::Fcv => v *= ucf(Field::Flow),
                    _ => {}
                }
                v
            }
            EN_ENERGY => {
                if hyd.link_flow.is_empty() {
                    0.0
                } else {
                    hydraul::getenergy(pr, i).0
                }
            }
            EN_LINKQUAL => quality::avgqual(pr, i) * ucf(Field::LinkQual),
            EN_LINKPATTERN => {
                if link.link_type == LinkType::Pump {
                    pump().upat as f64
                } else {
                    0.0
                }
            }
            EN_PUMP_STATE => {
                let mut v = status as i32 as f64;
                if link.link_type == LinkType::Pump && status >= Status::Open {
                    if flow > setting * pump().qmax {
                        v = Status::XFlow as i32 as f64;
                    }
                    if flow < 0.0 {
                        v = Status::XHead as i32 as f64;
                    }
                }
                v
            }
            EN_PUMP_EFFIC => {
                if hyd.link_flow.is_empty() {
                    0.0
                } else {
                    hydraul::getenergy(pr, i).1
                }
            }
            EN_PUMP_POWER => {
                if link.link_type == LinkType::Pump && pump().ptype == PumpType::ConstHp {
                    link.km
                } else {
                    0.0
                }
            }
            EN_PUMP_HCURVE => {
                if link.link_type == LinkType::Pump {
                    pump().hcurve as f64
                } else {
                    0.0
                }
            }
            EN_PUMP_ECURVE => {
                if link.link_type == LinkType::Pump {
                    pump().ecurve as f64
                } else {
                    0.0
                }
            }
            EN_PUMP_ECOST => {
                if link.link_type == LinkType::Pump {
                    pump().ecost
                } else {
                    0.0
                }
            }
            EN_PUMP_EPAT => {
                if link.link_type == LinkType::Pump {
                    pump().epat as f64
                } else {
                    0.0
                }
            }
            EN_PCV_CURVE => {
                if link.link_type == LinkType::Pcv {
                    net.valve[net.findvalve(i)].curve as f64
                } else {
                    0.0
                }
            }
            EN_GPV_CURVE => {
                if link.link_type == LinkType::Gpv {
                    link.kc
                } else {
                    0.0
                }
            }
            EN_LINK_INCONTROL => f64::from(u8::from(Self::incontrols(pr, false, i))),
            EN_LEAK_AREA => link.leak_area / ucf(Field::Length),
            EN_LEAK_EXPAN => link.leak_expan / ucf(Field::Length),
            EN_LINK_LEAKAGE => {
                if hyd.has_leakage && !hyd.leakage.is_empty() {
                    leakage::findlinkleakage(pr, i) * ucf(Field::Flow)
                } else {
                    0.0
                }
            }
            EN_VALVE_TYPE => {
                if link.link_type > LinkType::Pump {
                    link.link_type as i32 as f64
                } else {
                    0.0
                }
            }
            _ => return 251,
        };
        *value = v;
        0
    }

    /// `EN_getlinkvalues`
    pub fn getlinkvalues(&self, property: i32, values: &mut [f64]) -> i32 {
        let n = self.o().map_or(0, |o| o.pr.net.nlinks);
        for i in 1..=n {
            let Some(slot) = values.get_mut(i - 1) else {
                return 251;
            };
            let e = self.getlinkvalue(i as i32, property, slot);
            if e != 0 {
                return e;
            }
        }
        0
    }

    /// `EN_getvertexcount`
    pub fn getvertexcount(&self, index: i32, count: &mut i32) -> i32 {
        *count = 0;
        let Some(o) = self.o() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        *count = o.meta.link_vertices[index as usize].len() as i32;
        0
    }

    /// `EN_getvertex`
    pub fn getvertex(&self, index: i32, vertex: i32, x: &mut f64, y: &mut f64) -> i32 {
        *x = MISSING;
        *y = MISSING;
        let Some(o) = self.o() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        let v = &o.meta.link_vertices[index as usize];
        if vertex <= 0 || vertex as usize > v.len() {
            return 255;
        }
        (*x, *y) = v[vertex as usize - 1];
        0
    }

    /// `EN_getpumptype`
    pub fn getpumptype(&self, link_index: i32, pump_type: &mut i32) -> i32 {
        *pump_type = -1;
        let Some(o) = self.o() else { return 102 };
        let net = &o.pr.net;
        if link_index < 1 || link_index as usize > net.nlinks {
            return 204;
        }
        let k = link_index as usize;
        if net.link[k].link_type != LinkType::Pump {
            return 216;
        }
        *pump_type = net.pump[net.findpump(k)].ptype as i32;
        0
    }

    /// `EN_getheadcurveindex`
    pub fn getheadcurveindex(&self, link_index: i32, curve_index: &mut i32) -> i32 {
        *curve_index = 0;
        let Some(o) = self.o() else { return 102 };
        let net = &o.pr.net;
        if link_index < 1 || link_index as usize > net.nlinks {
            return 204;
        }
        let k = link_index as usize;
        if net.link[k].link_type != LinkType::Pump {
            return 216;
        }
        *curve_index = net.pump[net.findpump(k)].hcurve as i32;
        0
    }

    // ---- Time patterns ---------------------------------------------------------------

    fn npats(o: &Open) -> usize {
        o.pr.net.pattern.len() - 1
    }

    /// `EN_getpatternindex`
    pub fn getpatternindex(&self, id: &str, index: &mut i32) -> i32 {
        *index = 0;
        let Some(o) = self.o() else { return 102 };
        for i in 1..=Self::npats(o) {
            if o.pr.net.pattern[i].id == id {
                *index = i as i32;
                return 0;
            }
        }
        205
    }

    /// `EN_getpatternid`
    pub fn getpatternid(&self, index: i32, id: &mut String) -> i32 {
        id.clear();
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > Self::npats(o) {
            return 205;
        }
        id.push_str(&o.pr.net.pattern[index as usize].id);
        0
    }

    /// `EN_getpatternlen`
    pub fn getpatternlen(&self, index: i32, len: &mut i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > Self::npats(o) {
            return 205;
        }
        *len = o.pr.net.pattern[index as usize].f.len() as i32;
        0
    }

    /// `EN_getpatternvalue`
    pub fn getpatternvalue(&self, index: i32, period: i32, value: &mut f64) -> i32 {
        *value = 0.0;
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > Self::npats(o) {
            return 205;
        }
        let f = &o.pr.net.pattern[index as usize].f;
        if period < 1 || period as usize > f.len() {
            return 251;
        }
        *value = f[period as usize - 1];
        0
    }

    /// `EN_getaveragepatternvalue`
    pub fn getaveragepatternvalue(&self, index: i32, value: &mut f64) -> i32 {
        *value = 0.0;
        let Some(o) = self.o() else { return 102 };
        if index < 0 || index as usize > Self::npats(o) {
            return 205;
        }
        let f = &o.pr.net.pattern[index as usize].f;
        for x in f {
            *value += *x;
        }
        *value /= f.len() as f64;
        0
    }

    // ---- Data curves -----------------------------------------------------------------

    fn ncurves(o: &Open) -> usize {
        o.pr.net.curve.len() - 1
    }

    /// `EN_getcurveindex`
    pub fn getcurveindex(&self, id: &str, index: &mut i32) -> i32 {
        *index = 0;
        let Some(o) = self.o() else { return 102 };
        *index = (1..=Self::ncurves(o))
            .find(|&i| o.pr.net.curve[i].id == id)
            .unwrap_or(0) as i32;
        if *index == 0 { 206 } else { 0 }
    }

    /// `EN_getcurveid`
    pub fn getcurveid(&self, index: i32, id: &mut String) -> i32 {
        id.clear();
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > Self::ncurves(o) {
            return 206;
        }
        id.push_str(&o.pr.net.curve[index as usize].id);
        0
    }

    /// `EN_getcurvelen`
    pub fn getcurvelen(&self, index: i32, len: &mut i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > Self::ncurves(o) {
            return 206;
        }
        *len = o.pr.net.curve[index as usize].x.len() as i32;
        0
    }

    /// `EN_getcurvetype`
    pub fn getcurvetype(&self, index: i32, curve_type: &mut i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if index < 1 || index as usize > Self::ncurves(o) {
            return 206;
        }
        *curve_type = o.curve_type[index as usize];
        0
    }

    /// `EN_getcurvevalue`
    pub fn getcurvevalue(
        &self,
        curve_index: i32,
        point_index: i32,
        x: &mut f64,
        y: &mut f64,
    ) -> i32 {
        *x = 0.0;
        *y = 0.0;
        let Some(o) = self.o() else { return 102 };
        if curve_index < 1 || curve_index as usize > Self::ncurves(o) {
            return 206;
        }
        let c = &o.pr.net.curve[curve_index as usize];
        if point_index < 1 || point_index as usize > c.x.len() {
            return 251;
        }
        *x = c.x[point_index as usize - 1];
        *y = c.y[point_index as usize - 1];
        0
    }

    /// `EN_getcurve`: the curve's ID and points (the caller's arrays must hold them).
    pub fn getcurve(&self, index: i32, id: &mut String, x: &mut Vec<f64>, y: &mut Vec<f64>) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if index <= 0 || index as usize > Self::ncurves(o) {
            return 206;
        }
        let c = &o.pr.net.curve[index as usize];
        *id = c.id.clone();
        truncate_bytes(id, MAXID);
        *x = c.x.clone();
        *y = c.y.clone();
        0
    }

    // ---- Simple controls -------------------------------------------------------------

    /// `EN_getcontrol`
    pub fn getcontrol(
        &self,
        index: i32,
        control_type: &mut i32,
        link_index: &mut i32,
        setting: &mut f64,
        node_index: &mut i32,
        level: &mut f64,
    ) -> i32 {
        *control_type = 0;
        *link_index = 0;
        *node_index = 0;
        let Some(o) = self.o() else { return 102 };
        let net = &o.pr.net;
        if index <= 0 || index as usize > net.ncontrols {
            return 241;
        }
        let ucf = |f: Field| o.pr.units.ucf[f as usize];
        let c = &net.control[index as usize];
        *control_type = c.control_type as i32;
        *link_index = c.link as i32;
        let mut s = c.setting;
        if c.setting != MISSING {
            match net.link[c.link].link_type {
                LinkType::Prv | LinkType::Psv | LinkType::Pbv => s *= ucf(Field::Pressure),
                LinkType::Fcv => s *= ucf(Field::Flow),
                _ => {}
            }
        } else if c.status == Status::Open {
            s = SET_OPEN;
        } else {
            s = SET_CLOSED;
        }
        *node_index = c.node as i32;
        let lvl = if c.node > 0 {
            let node = &net.node[c.node];
            if c.node > net.njuncs {
                (c.grade - node.el) * ucf(Field::Elev)
            } else {
                (c.grade - node.el) * ucf(Field::Pressure)
            }
        } else {
            c.time as f64
        };
        *setting = s;
        *level = lvl;
        0
    }

    /// `EN_getcontrolenabled`
    pub fn getcontrolenabled(&self, index: i32, enabled: &mut i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.ncontrols {
            return 241;
        }
        *enabled = i32::from(o.pr.net.control[index as usize].is_enabled);
        0
    }
}
