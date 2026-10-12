// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (quality.c, qualroute.c, qualreact.c), Copyright (c)
// 2019 OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.

//! Water quality: chemical, water age and source tracing by the Lagrangian
//! time-driven method, with bulk and wall reactions and four tank mixing models.
//!
//! Like EPANET's `EN_solveQ`, quality is routed over hydraulic solutions recorded
//! during the hydraulic run with EPANET's hydraulics-file precision (f32), so results
//! match the reference to the bit.

use crate::Project;
use crate::types::*;

const NIL: u32 = u32::MAX;

/// Default concentration and age tolerances (input1.c).
pub const AGETOL: f64 = 0.01;
pub const CHEMTOL: f64 = 0.01;
pub const DIFFUS: f64 = 1.3e-8;
pub const L_PER_FT3: f64 = 28.317;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MixModel {
    #[default]
    Mix1,
    Mix2,
    Fifo,
    Lifo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceType {
    Concen,
    Mass,
    Setpoint,
    FlowPaced,
}

#[derive(Clone, Debug)]
pub struct Source {
    pub kind: SourceType,
    /// Strength in user units.
    pub c0: f64,
    pub pat: usize,
    pub smass: f64,
}

#[derive(Clone, Copy, Debug, Default)]
struct Seg {
    v: f64,
    c: f64,
    prev: u32,
}

#[derive(Clone, Debug, Default)]
pub struct MassBalance {
    pub initial: f64,
    pub inflow: f64,
    pub outflow: f64,
    pub reacted: f64,
    pub final_: f64,
    pub ratio: f64,
    pub seg_count: i64,
}

/// EPANET's Quality struct.
#[derive(Clone, Debug)]
pub struct Quality {
    pub qualflag: QualType,
    pub trace_node: usize,
    pub chem_name: String,
    pub chem_units: String,
    pub ctol: f64,
    pub diffus: f64,
    pub climit: f64,
    pub bulk_order: f64,
    pub wall_order: f64,
    pub tank_order: f64,
    pub kbulk: f64,
    pub kwall: f64,
    pub rfactor: f64,
    pub sc: f64,
    pub bucf: f64,
    pub tucf: f64,
    pub reactflag: bool,
    pub node_qual: Vec<f64>,
    pub pipe_rate_coeff: Vec<f64>,
    flow_dir: Vec<i32>,
    segs: Vec<Seg>,
    first: Vec<u32>,
    last: Vec<u32>,
    free: u32,
    sorted: Vec<usize>,
    /// For each node, (opposite node, link) in EPANET's adjacency-list order.
    adj: Vec<Vec<(usize, usize)>>,
    source_qual: f64,
    pub mass: MassBalance,
    pub wbulk: f64,
    pub wwall: f64,
    pub wtank: f64,
    pub wsource: f64,
    /// `OpenQflag`: the toolkit's quality solver is open (only the toolkit sets it).
    pub open_q: bool,
}

impl Default for Quality {
    /// `setdefaults` (input1.c).
    fn default() -> Self {
        Quality {
            open_q: false,
            qualflag: QualType::None,
            trace_node: 0,
            chem_name: "Chemical".into(),
            chem_units: "mg/L".into(),
            ctol: MISSING,
            diffus: MISSING,
            climit: 0.0,
            bulk_order: 1.0,
            wall_order: 1.0,
            tank_order: 1.0,
            kbulk: 0.0,
            kwall: 0.0,
            rfactor: 0.0,
            sc: 0.0,
            bucf: 1.0,
            tucf: 1.0,
            reactflag: false,
            node_qual: Vec::new(),
            pipe_rate_coeff: Vec::new(),
            flow_dir: Vec::new(),
            segs: Vec::new(),
            first: Vec::new(),
            last: Vec::new(),
            free: NIL,
            sorted: Vec::new(),
            adj: Vec::new(),
            source_qual: 0.0,
            mass: MassBalance::default(),
            wbulk: 0.0,
            wwall: 0.0,
            wtank: 0.0,
            wsource: 0.0,
        }
    }
}

/// One hydraulic solution as EPANET's hydraulics file stores it, with the file's
/// f32 precision, and the time step that followed it.
#[derive(Clone, Debug)]
pub struct HydRecord {
    pub htime: i64,
    pub hydstep: i64,
    demand: Vec<f32>,
    head: Vec<f32>,
    flow: Vec<f32>,
    status: Vec<u8>,
    setting: Vec<f32>,
}

impl HydRecord {
    /// Node demands (consumer demand, emitter and leakage flow) in cfs, solver node order.
    pub fn demand(&self) -> &[f32] {
        &self.demand
    }

    /// Node heads in feet, solver node order.
    pub fn head(&self) -> &[f32] {
        &self.head
    }

    /// Link flows in cfs, zero for closed links.
    pub fn flow(&self) -> &[f32] {
        &self.flow
    }

    /// Link status codes (EPANET's `StatusType`), as the file stores them.
    pub fn status(&self) -> impl Iterator<Item = f32> + '_ {
        self.status.iter().map(|&s| f32::from(s))
    }
}

/// `savehyd`: the current hydraulic solution as the hydraulics file keeps it.
pub fn savehyd(pr: &Project, htime: i64) -> HydRecord {
    let hyd = &pr.hyd;
    let nn = pr.net.nnodes;
    let nl = pr.net.nlinks;
    HydRecord {
        htime,
        hydstep: 0,
        demand: (1..=nn).map(|i| hyd.node_demand[i] as f32).collect(),
        head: (1..=nn).map(|i| hyd.node_head[i] as f32).collect(),
        flow: (1..=nl)
            .map(|k| {
                if hyd.link_status[k] <= Status::Closed {
                    0.0
                } else {
                    hyd.link_flow[k] as f32
                }
            })
            .collect(),
        status: (1..=nl).map(|k| hyd.link_status[k] as u8).collect(),
        setting: (1..=nl).map(|k| hyd.link_setting[k] as f32).collect(),
    }
}

/// `readhyd`: load a recorded solution into the hydraulic state.
pub fn readhyd(pr: &mut Project, r: &HydRecord) {
    let hyd = &mut pr.hyd;
    for (i, v) in r.demand.iter().enumerate() {
        hyd.node_demand[i + 1] = f64::from(*v);
    }
    for (i, v) in r.head.iter().enumerate() {
        hyd.node_head[i + 1] = f64::from(*v);
    }
    for (k, v) in r.flow.iter().enumerate() {
        hyd.link_flow[k + 1] = f64::from(*v);
    }
    for (k, v) in r.status.iter().enumerate() {
        hyd.link_status[k + 1] = Status::from_code(*v as i8);
    }
    for (k, v) in r.setting.iter().enumerate() {
        hyd.link_setting[k + 1] = f64::from(*v);
    }
}

/// `MAGICNUMBER` and `ENGINE_VERSION` (types.h), which open a hydraulics file.
const MAGICNUMBER: i32 = 516_114_521;
const ENGINE_VERSION: i32 = 201;
const EOFMARK: u8 = 0x1A;

/// The sizes a hydraulics file records (`openhydfile`): nodes, links, tanks, pumps,
/// valves and the duration.
pub fn hydfile_sizes(pr: &Project) -> [i32; 6] {
    let n = &pr.net;
    [
        n.nnodes as i32,
        n.nlinks as i32,
        n.ntanks as i32,
        n.npumps as i32,
        n.nvalves as i32,
        pr.times.dur as i32,
    ]
}

/// EPANET's binary hydraulics file (`openhydfile`, `savehyd`, `savehydstep`).
pub fn hydfile_bytes(sizes: &[i32; 6], records: &[HydRecord]) -> Vec<u8> {
    let mut b = Vec::new();
    for v in [MAGICNUMBER, ENGINE_VERSION].iter().chain(sizes) {
        b.extend_from_slice(&v.to_le_bytes());
    }
    for r in records {
        b.extend_from_slice(&(r.htime as i32).to_le_bytes());
        for x in r.demand.iter().chain(&r.head).chain(&r.flow) {
            b.extend_from_slice(&x.to_le_bytes());
        }
        for s in &r.status {
            b.extend_from_slice(&f32::from(*s).to_le_bytes());
        }
        for x in &r.setting {
            b.extend_from_slice(&x.to_le_bytes());
        }
        b.extend_from_slice(&(r.hydstep as i32).to_le_bytes());
        // `savehydstep` marks the end of a run with EOFMARK, which `readhyd` does
        // not skip.
        if r.hydstep as i32 == 0 {
            b.push(EOFMARK);
        }
    }
    b
}

/// Read a hydraulics file for this network (`openhydfile` with `USE`, then `readhyd`
/// and `readhydstep` for each solution): 306 if it was saved for another network. A
/// solution cut short ends the records, as reading it fails in EPANET.
pub fn read_hydfile(pr: &Project, bytes: &[u8]) -> Result<Vec<HydRecord>, i32> {
    let mut at = 0usize;
    let mut word = || -> Option<[u8; 4]> {
        let w = bytes.get(at..at + 4)?.try_into().ok()?;
        at += 4;
        Some(w)
    };
    let int = |w: [u8; 4]| i32::from_le_bytes(w);
    if word().map(int) != Some(MAGICNUMBER) || word().map(int) != Some(ENGINE_VERSION) {
        return Err(306);
    }
    let mut sizes = [0i32; 6];
    for s in &mut sizes {
        *s = word().map(int).ok_or(306)?;
    }
    if sizes != hydfile_sizes(pr) {
        return Err(306);
    }
    let (nn, nl) = (pr.net.nnodes, pr.net.nlinks);
    let mut records = Vec::new();
    while let Some(t) = word() {
        let mut floats = |n: usize| -> Option<Vec<f32>> {
            (0..n).map(|_| word().map(f32::from_le_bytes)).collect()
        };
        let (Some(demand), Some(head), Some(flow), Some(status), Some(setting)) =
            (floats(nn), floats(nn), floats(nl), floats(nl), floats(nl))
        else {
            break;
        };
        let Some(step) = word() else { break };
        records.push(HydRecord {
            htime: i64::from(int(t)),
            hydstep: i64::from(int(step)),
            demand,
            head,
            flow,
            // `(char)x[i]`
            status: status.iter().map(|&s| s as i8 as u8).collect(),
            setting,
        });
    }
    Ok(records)
}

fn q_stagnant() -> f64 {
    0.005 / GPM_PER_CFS
}

/// `LINKFLOW`: flow as saved to the hydraulics file.
fn linkflow(pr: &Project, k: usize) -> f64 {
    if pr.hyd.link_status[k] <= Status::Closed {
        0.0
    } else {
        pr.hyd.link_flow[k]
    }
}

/// `LINKVOL`: EPANET's truncated pi/4, kept for identical volumes.
#[allow(clippy::approx_constant)]
fn linkvol(pr: &Project, k: usize) -> f64 {
    let l = &pr.net.link[k];
    0.785398 * l.len * (l.diam * l.diam)
}

/// `openqual`
pub fn openqual(pr: &mut Project) -> Result<(), i32> {
    if pr.qual.qualflag == QualType::None {
        return Ok(());
    }
    let net = &pr.net;
    if net.nnodes < 2 {
        return Err(223);
    }
    if net.ntanks == 0 {
        return Err(224);
    }
    let adj = pr.adjlist.clone();
    let q = &mut pr.qual;
    q.adj = adj;
    q.flow_dir = vec![0; net.nlinks + 1];
    q.pipe_rate_coeff = vec![0.0; net.nlinks + 1];
    let n = net.nlinks + net.ntanks + 1;
    q.first = vec![NIL; n];
    q.last = vec![NIL; n];
    q.sorted = vec![0; n];
    // NodeQual lives from EN_open on (allocdata); a second run keeps the first's values
    // until initqual sets them.
    if q.node_qual.len() != net.nnodes + 1 {
        q.node_qual = vec![0.0; net.nnodes + 1];
    }
    Ok(())
}

/// `initqual`
pub fn initqual(pr: &mut Project) {
    pr.times.qtime = 0;
    pr.times.htime = 0;
    pr.times.rtime = pr.times.rstart;
    let nn = pr.net.nnodes;
    if pr.qual.node_qual.len() != nn + 1 {
        pr.qual.node_qual = vec![0.0; nn + 1];
    }
    for i in 1..=nn {
        pr.qual.node_qual[i] = if pr.qual.qualflag == QualType::Trace {
            0.0
        } else {
            pr.net.node[i].c0
        };
        if let Some(s) = &mut pr.net.node[i].source {
            s.smass = 0.0;
        }
    }
    if pr.qual.qualflag == QualType::None {
        return;
    }
    for i in 1..=pr.net.ntanks {
        let n = pr.net.tank[i].node;
        pr.net.tank[i].c = pr.qual.node_qual[n];
    }
    if pr.qual.qualflag == QualType::Trace {
        let t = pr.qual.trace_node;
        pr.qual.node_qual[t] = 100.0;
    }
    let q = &mut pr.qual;
    q.sc = if q.diffus > 0.0 {
        pr.hyd.viscos / q.diffus
    } else {
        0.0
    };
    q.bucf = getucf(q.bulk_order);
    q.tucf = getucf(q.tank_order);
    let reactflag = setreactflag(pr);
    pr.qual.reactflag = reactflag;
    let q = &mut pr.qual;
    q.free = NIL;
    q.segs.clear();
    q.mass = MassBalance::default();
    initsegs(pr);
    let q = &mut pr.qual;
    for d in q.flow_dir.iter_mut() {
        *d = 0;
    }
    q.wbulk = 0.0;
    q.wwall = 0.0;
    q.wtank = 0.0;
    q.wsource = 0.0;
    let stored = findstoredmass(pr);
    let m = &mut pr.qual.mass;
    m.initial = stored;
    m.inflow = 0.0;
    m.outflow = 0.0;
    m.reacted = 0.0;
    m.final_ = 0.0;
    m.ratio = 0.0;
    m.seg_count = 0;
}

/// The part of `runqual` after reading a hydraulic solution at the current time:
/// rate coefficients and the topological sort. Returns an EPANET error code.
pub fn runqual_update(pr: &mut Project) -> Result<(), i32> {
    if pr.qual.qualflag != QualType::None && pr.times.qtime < pr.times.dur {
        if pr.qual.reactflag && pr.qual.qualflag != QualType::Age {
            ratecoeffs(pr);
        }
        if flowdirchanged(pr) {
            sortnodes(pr)?;
        }
    }
    Ok(())
}

/// `nextqual`: route quality to the next hydraulic event. Returns the step taken.
pub fn nextqual(pr: &mut Project) -> i64 {
    let t = &pr.times;
    let hydstep = if t.htime <= t.dur {
        t.htime - t.qtime
    } else {
        0
    };
    if pr.qual.qualflag != QualType::None && hydstep > 0 {
        let mut qtime = 0;
        while qtime < hydstep {
            let dt = pr.times.qstep.min(hydstep - qtime);
            qtime += dt;
            transport(pr, dt);
        }
    }
    evalmassbalance(pr);
    pr.times.qtime += hydstep;
    if hydstep == 0
        && pr.qual.qualflag != QualType::None
        && pr.rpt.statflag != crate::report::Statflag::No
        && crate::report::writing(pr)
    {
        crate::report::writemassbalance(pr);
    }
    hydstep
}

/// `closequal`: free the segments (links then average their end nodes' quality).
pub fn closequal(pr: &mut Project) {
    if pr.qual.qualflag != QualType::None {
        let q = &mut pr.qual;
        q.segs.clear();
        q.first.clear();
        q.last.clear();
        q.free = NIL;
        q.pipe_rate_coeff.clear();
        q.flow_dir.clear();
        q.sorted.clear();
    }
}

/// `avgqual`: average quality in a link.
pub fn avgqual(pr: &Project, k: usize) -> f64 {
    let q = &pr.qual;
    if q.qualflag == QualType::None {
        return 0.0;
    }
    let mut vsum = 0.0;
    let mut msum = 0.0;
    if !q.first.is_empty() {
        let mut s = q.first[k];
        while s != NIL {
            let seg = &q.segs[s as usize];
            vsum += seg.v;
            msum += seg.c * seg.v;
            s = seg.prev;
        }
    }
    if vsum > 0.0 {
        msum / vsum
    } else {
        let l = &pr.net.link[k];
        (q.node_qual[l.n1] + q.node_qual[l.n2]) / 2.0
    }
}

fn findsourcequal(pr: &mut Project, n: usize, volout: f64, tstep: i64) -> f64 {
    if pr.qual.qualflag != QualType::Chem {
        return 0.0;
    }
    let Some(source) = pr.net.node[n].source.clone() else {
        return 0.0;
    };
    if source.c0 == 0.0 {
        return 0.0;
    }
    if volout / tstep as f64 <= q_stagnant() {
        return 0.0;
    }
    let mut c = sourcequal(pr, &source);
    match source.kind {
        SourceType::Concen => {
            if pr.net.node[n].node_type == NodeType::Junction {
                if pr.hyd.node_demand[n] < 0.0 {
                    c = -c * pr.hyd.node_demand[n] * tstep as f64 / volout;
                } else {
                    c = 0.0;
                }
            }
        }
        SourceType::Mass => c = c * tstep as f64 / volout,
        SourceType::Setpoint => c = (c - pr.qual.node_qual[n]).max(0.0),
        SourceType::FlowPaced => {}
    }
    let massadded = c * volout;
    if let Some(s) = &mut pr.net.node[n].source {
        s.smass += massadded;
    }
    if pr.times.htime >= pr.times.rstart {
        pr.qual.wsource += massadded;
    }
    c
}

fn sourcequal(pr: &Project, source: &Source) -> f64 {
    let mut c = source.c0;
    if source.kind == SourceType::Mass {
        c /= 60.0;
    } else {
        c /= pr.units.ucf[Field::Quality as usize];
    }
    let i = source.pat;
    if i == 0 {
        return c;
    }
    let t = &pr.times;
    let f = &pr.net.pattern[i].f;
    let k = ((t.qtime + t.pstart) / t.pstep) % f.len() as i64;
    c * f[k as usize]
}

pub(crate) fn evalmassbalance(pr: &mut Project) {
    if pr.qual.qualflag == QualType::None {
        pr.qual.mass.ratio = 1.0;
        return;
    }
    let stored = findstoredmass(pr);
    let m = &mut pr.qual.mass;
    m.final_ = stored;
    let mut massin = m.initial + m.inflow;
    let mut massout = m.outflow + m.final_;
    let massreacted = m.reacted;
    if massreacted > 0.0 {
        massout += massreacted;
    } else {
        massin -= massreacted;
    }
    m.ratio = if massin == 0.0 { 1.0 } else { massout / massin };
}

fn findstoredmass(pr: &Project) -> f64 {
    let q = &pr.qual;
    let mut total = 0.0;
    for k in 1..=pr.net.nlinks {
        let mut s = q.first[k];
        while s != NIL {
            let seg = &q.segs[s as usize];
            total += seg.c * seg.v;
            s = seg.prev;
        }
    }
    for i in 1..=pr.net.ntanks {
        if pr.net.tank[i].a == 0.0 {
            continue;
        }
        let mut s = q.first[pr.net.nlinks + i];
        while s != NIL {
            let seg = &q.segs[s as usize];
            total += seg.c * seg.v;
            s = seg.prev;
        }
    }
    total
}

fn flowdirchanged(pr: &mut Project) -> bool {
    let mut result = false;
    for k in 1..=pr.net.nlinks {
        let olddir = pr.qual.flow_dir[k];
        let q = linkflow(pr, k);
        let mut newdir = if q < 0.0 { -1 } else { 1 };
        if q.abs() < q_stagnant() {
            newdir = 0;
        }
        if newdir * olddir < 0 {
            reversesegs(pr, k);
        }
        if newdir != olddir {
            result = true;
        }
        pr.qual.flow_dir[k] = newdir;
    }
    result
}

// ---- qualroute.c ----

pub(crate) fn transport(pr: &mut Project, tstep: i64) {
    if pr.qual.reactflag {
        reactpipes(pr, tstep);
        reacttanks(pr, tstep);
    }
    for j in 1..=pr.net.nnodes {
        let n = pr.qual.sorted[j];
        let mut volin = 0.0;
        let mut massin = 0.0;
        let mut volout = 0.0;
        for a in 0..pr.qual.adj[n].len() {
            let k = pr.qual.adj[n][a].1;
            let l = &pr.net.link[k];
            let m = if pr.qual.flow_dir[k] < 0 { l.n1 } else { l.n2 };
            if m == n {
                evalnodeinflow(pr, k, tstep, &mut volin, &mut massin);
            } else {
                volout += linkflow(pr, k).abs();
            }
        }
        if pr.net.node[n].node_type == NodeType::Junction {
            volout += pr.hyd.node_demand[n].max(0.0);
        }
        volout *= tstep as f64;
        let nodequal = findnodequal(pr, n, volin, massin, volout, tstep);
        for a in 0..pr.qual.adj[n].len() {
            let k = pr.qual.adj[n][a].1;
            let l = &pr.net.link[k];
            let m = if pr.qual.flow_dir[k] < 0 { l.n2 } else { l.n1 };
            if m == n {
                evalnodeoutflow(pr, k, nodequal, tstep);
            }
        }
        updatemassbalance(pr, n, massin, volout, tstep);
    }
}

fn evalnodeinflow(pr: &mut Project, k: usize, tstep: i64, volin: &mut f64, massin: &mut f64) {
    let q = linkflow(pr, k);
    let mut v = q.abs() * tstep as f64;
    let qual = &mut pr.qual;
    while v > 0.0 {
        let s = qual.first[k];
        if s == NIL {
            break;
        }
        let seg = qual.segs[s as usize];
        let vseg = seg.v.min(v);
        *volin += vseg;
        *massin += vseg * seg.c;
        v -= vseg;
        if v >= 0.0 && vseg >= seg.v {
            qual.first[k] = seg.prev;
            if qual.first[k] == NIL {
                qual.last[k] = NIL;
            }
            qual.segs[s as usize].prev = qual.free;
            qual.free = s;
            qual.mass.seg_count -= 1;
        } else {
            qual.segs[s as usize].v -= vseg;
        }
    }
}

fn findnodequal(
    pr: &mut Project,
    n: usize,
    mut volin: f64,
    massin: f64,
    volout: f64,
    tstep: i64,
) -> f64 {
    match pr.net.node[n].node_type {
        NodeType::Junction => {
            volin -= pr.hyd.node_demand[n].min(0.0) * tstep as f64;
            if volin > 0.0 {
                pr.qual.node_qual[n] = massin / volin;
            } else if pr.qual.reactflag {
                pr.qual.node_qual[n] = noflowqual(pr, n);
            }
        }
        NodeType::Tank => {
            pr.qual.node_qual[n] = mixtank(pr, n, volin, massin, volout);
        }
        NodeType::Reservoir => {}
    }
    pr.qual.source_qual = 0.0;
    if pr.qual.qualflag == QualType::Trace {
        if n == pr.qual.trace_node {
            pr.qual.source_qual = if pr.net.node[n].node_type == NodeType::Reservoir {
                100.0
            } else {
                (100.0 - pr.qual.node_qual[n]).max(0.0)
            };
            pr.qual.node_qual[n] = 100.0;
        }
        return pr.qual.node_qual[n];
    }
    pr.qual.source_qual = findsourcequal(pr, n, volout, tstep);
    if pr.qual.source_qual == 0.0 {
        return pr.qual.node_qual[n];
    }
    let sq = pr.qual.source_qual;
    match pr.net.node[n].node_type {
        NodeType::Junction => {
            pr.qual.node_qual[n] += sq;
            pr.qual.node_qual[n]
        }
        NodeType::Tank => pr.qual.node_qual[n] + sq,
        NodeType::Reservoir => {
            pr.qual.node_qual[n] = sq;
            sq
        }
    }
}

fn noflowqual(pr: &Project, n: usize) -> f64 {
    let q = &pr.qual;
    let mut c = 0.0;
    let mut kount = 0;
    for &(_, k) in &q.adj[n] {
        let dir = q.flow_dir[k];
        let l = &pr.net.link[k];
        let inflow = (l.n2 == n && dir >= 0) || (l.n1 == n && dir < 0);
        if inflow && q.first[k] != NIL {
            c += q.segs[q.first[k] as usize].c;
            kount += 1;
        } else if !inflow && q.last[k] != NIL {
            c += q.segs[q.last[k] as usize].c;
            kount += 1;
        }
    }
    if kount > 0 {
        c /= f64::from(kount);
    }
    c
}

fn evalnodeoutflow(pr: &mut Project, k: usize, c: f64, tstep: i64) {
    let v = linkflow(pr, k).abs() * tstep as f64;
    if v == 0.0 {
        return;
    }
    let qual = &mut pr.qual;
    let s = qual.last[k];
    if s != NIL {
        let seg = &mut qual.segs[s as usize];
        if (seg.c - c).abs() < qual.ctol {
            seg.c = (seg.c * seg.v + c * v) / (seg.v + v);
            seg.v += v;
        } else {
            addseg(qual, k, v, c);
        }
    } else {
        addseg(qual, k, v, c);
    }
}

fn updatemassbalance(pr: &mut Project, n: usize, massin: f64, volout: f64, tstep: i64) {
    let q = &mut pr.qual;
    let (masslost, massadded) = match pr.net.node[n].node_type {
        NodeType::Junction => (
            pr.hyd.node_demand[n].max(0.0) * tstep as f64 * q.node_qual[n],
            q.source_qual * volout,
        ),
        NodeType::Reservoir => (
            massin,
            if q.source_qual > 0.0 {
                q.source_qual * volout
            } else {
                q.node_qual[n] * volout
            },
        ),
        NodeType::Tank => (0.0, q.source_qual * volout),
    };
    q.mass.outflow += masslost;
    q.mass.inflow += massadded;
}

fn sortnodes(pr: &mut Project) -> Result<(), i32> {
    let nn = pr.net.nnodes;
    let mut indegree = vec![0i32; nn + 1];
    let mut stack = vec![0usize; nn + 1];
    let mut stacksize = 0usize;
    let mut numsorted = 0usize;
    for k in 1..=pr.net.nlinks {
        let n = match pr.qual.flow_dir[k] {
            1 => pr.net.link[k].n2,
            -1 => pr.net.link[k].n1,
            _ => continue,
        };
        indegree[n] += 1;
    }
    for i in 1..=nn {
        if indegree[i] == 0 {
            stacksize += 1;
            stack[stacksize] = i;
        }
    }
    while numsorted < nn {
        if stacksize == 0 {
            let j = selectnonstacknode(pr, numsorted, &indegree);
            if j == 0 {
                break;
            }
            indegree[j] = 0;
            stacksize += 1;
            stack[stacksize] = j;
        }
        let i = stack[stacksize];
        stacksize -= 1;
        numsorted += 1;
        pr.qual.sorted[numsorted] = i;
        for a in 0..pr.qual.adj[i].len() {
            let k = pr.qual.adj[i][a].1;
            if pr.qual.flow_dir[k] == 0 {
                continue;
            }
            let n = if pr.qual.flow_dir[k] < 0 {
                pr.net.link[k].n1
            } else {
                pr.net.link[k].n2
            };
            if n != i && indegree[n] > 0 {
                indegree[n] -= 1;
                if indegree[n] == 0 {
                    stacksize += 1;
                    stack[stacksize] = n;
                }
            }
        }
    }
    if numsorted < nn { Err(120) } else { Ok(()) }
}

fn selectnonstacknode(pr: &Project, numsorted: usize, indegree: &[i32]) -> usize {
    for i in (1..=numsorted).rev() {
        let m = pr.qual.sorted[i];
        for &(n, _) in &pr.qual.adj[m] {
            if indegree[n] > 0 {
                return n;
            }
        }
    }
    (1..=pr.net.nnodes).find(|&i| indegree[i] > 0).unwrap_or(0)
}

fn initsegs(pr: &mut Project) {
    for k in 1..=pr.net.nlinks {
        pr.qual.first[k] = NIL;
        pr.qual.last[k] = NIL;
        if pr.net.link[k].link_type == LinkType::Pipe {
            let v = linkvol(pr, k);
            let j = pr.net.link[k].n2;
            let c = pr.qual.node_qual[j];
            addseg(&mut pr.qual, k, v, c);
        }
    }
    for j in 1..=pr.net.ntanks {
        let tank = &pr.net.tank[j];
        if tank.a == 0.0 {
            continue;
        }
        let c = pr.net.node[tank.node].c0;
        let mut v = tank.v0;
        let k = pr.net.nlinks + j;
        let (mix, v1frac, vmax) = (tank.mix_model, tank.v1frac, tank.vmax);
        let q = &mut pr.qual;
        q.first[k] = NIL;
        q.last[k] = NIL;
        addseg(q, k, v, c);
        if mix == MixModel::Mix2 {
            let v1 = (v - v1frac * vmax).max(0.0);
            let f = q.first[k] as usize;
            q.segs[f].v = v1;
            v -= v1;
            addseg(q, k, v, c);
        }
    }
}

fn reversesegs(pr: &mut Project, k: usize) {
    let q = &mut pr.qual;
    std::mem::swap(&mut q.first[k], &mut q.last[k]);
    let mut seg = q.last[k];
    let mut pseg = NIL;
    while seg != NIL {
        let nseg = q.segs[seg as usize].prev;
        q.segs[seg as usize].prev = pseg;
        pseg = seg;
        seg = nseg;
    }
}

fn addseg(q: &mut Quality, k: usize, v: f64, c: f64) {
    let s = if q.free != NIL {
        let s = q.free;
        q.free = q.segs[s as usize].prev;
        s
    } else {
        q.segs.push(Seg::default());
        (q.segs.len() - 1) as u32
    };
    q.segs[s as usize] = Seg { v, c, prev: NIL };
    if q.first[k] == NIL {
        q.first[k] = s;
    }
    if q.last[k] != NIL {
        let l = q.last[k] as usize;
        q.segs[l].prev = s;
    }
    q.last[k] = s;
    q.mass.seg_count += 1;
}

// ---- qualreact.c ----

fn setreactflag(pr: &Project) -> bool {
    match pr.qual.qualflag {
        QualType::Trace => false,
        QualType::Age => true,
        _ => {
            (1..=pr.net.nlinks).any(|i| {
                let l = &pr.net.link[i];
                l.link_type <= LinkType::Pipe && (l.kb != 0.0 || l.kw != 0.0)
            }) || (1..=pr.net.ntanks).any(|i| pr.net.tank[i].kb != 0.0)
        }
    }
}

pub fn getucf(order: f64) -> f64 {
    let order = if order < 0.0 { 0.0 } else { order };
    if order == 1.0 {
        1.0
    } else {
        1.0 / pow(L_PER_FT3, order - 1.0)
    }
}

fn ratecoeffs(pr: &mut Project) {
    for k in 1..=pr.net.nlinks {
        let mut kw = pr.net.link[k].kw;
        if kw != 0.0 {
            kw = piperate(pr, k);
        }
        pr.net.link[k].rc = kw;
        pr.qual.pipe_rate_coeff[k] = 0.0;
    }
}

fn reactpipes(pr: &mut Project, dt: i64) {
    for k in 1..=pr.net.nlinks {
        if pr.net.link[k].link_type != LinkType::Pipe {
            continue;
        }
        let mut rsum = 0.0;
        let mut vsum = 0.0;
        let mut s = pr.qual.first[k];
        while s != NIL {
            let seg = pr.qual.segs[s as usize];
            let cseg = seg.c;
            let cnew = pipereact(pr, k, seg.c, seg.v, dt);
            pr.qual.segs[s as usize].c = cnew;
            pr.qual.mass.reacted += (cseg - cnew) * seg.v;
            if pr.qual.qualflag == QualType::Chem {
                rsum += (cnew - cseg).abs() * seg.v;
                vsum += seg.v;
            }
            s = seg.prev;
        }
        pr.qual.pipe_rate_coeff[k] = if vsum > 0.0 {
            rsum / vsum / dt as f64 * SECPERDAY as f64
        } else {
            0.0
        };
    }
}

fn reacttanks(pr: &mut Project, dt: i64) {
    for i in 1..=pr.net.ntanks {
        if pr.net.tank[i].a == 0.0 {
            continue;
        }
        let kb = pr.net.tank[i].kb;
        let k = pr.net.nlinks + i;
        let mut s = pr.qual.first[k];
        while s != NIL {
            let seg = pr.qual.segs[s as usize];
            let cnew = tankreact(pr, seg.c, seg.v, kb, dt);
            pr.qual.segs[s as usize].c = cnew;
            pr.qual.mass.reacted += (seg.c - cnew) * seg.v;
            s = seg.prev;
        }
    }
}

fn piperate(pr: &Project, k: usize) -> f64 {
    let l = &pr.net.link[k];
    let q = &pr.qual;
    let d = l.diam;
    if q.sc == 0.0 {
        if q.wall_order == 0.0 {
            return BIG;
        }
        return l.kw * (4.0 / d) / pr.units.ucf[Field::Elev as usize];
    }
    let flow = linkflow(pr, k);
    let a = PI * d * d / 4.0;
    let u = flow.abs() / a;
    let re = u * d / pr.hyd.viscos;
    let sh = if re < 1.0 {
        2.0
    } else if re >= 2300.0 {
        0.0149 * pow(re, 0.88) * pow(q.sc, 0.333)
    } else {
        let y = d / l.len * re * q.sc;
        3.65 + 0.0668 * y / (1.0 + 0.04 * pow(y, 0.667))
    };
    let kf = sh * q.diffus / d;
    if q.wall_order == 0.0 {
        return kf;
    }
    let kw = l.kw / pr.units.ucf[Field::Elev as usize];
    (4.0 / d) * kw * kf / (kf + kw.abs())
}

fn pipereact(pr: &mut Project, k: usize, c: f64, v: f64, dt: i64) -> f64 {
    if pr.qual.qualflag == QualType::Age {
        let dc = dt as f64 / 3600.0;
        return (c + dc).max(0.0);
    }
    let l = &pr.net.link[k];
    let rbulk = bulkrate(&pr.qual, c, l.kb, pr.qual.bulk_order) * pr.qual.bucf;
    let rwall = wallrate(pr, c, l.diam, l.kw, l.rc);
    let dcbulk = rbulk * dt as f64;
    let dcwall = rwall * dt as f64;
    if pr.times.htime >= pr.times.rstart {
        pr.qual.wbulk += dcbulk.abs() * v;
        pr.qual.wwall += dcwall.abs() * v;
    }
    let dc = dcbulk + dcwall;
    (c + dc).max(0.0)
}

fn tankreact(pr: &mut Project, c: f64, v: f64, kb: f64, dt: i64) -> f64 {
    let dc = if pr.qual.qualflag == QualType::Age {
        dt as f64 / 3600.0
    } else {
        let rbulk = bulkrate(&pr.qual, c, kb, pr.qual.tank_order) * pr.qual.tucf;
        let dc = rbulk * dt as f64;
        if pr.times.htime >= pr.times.rstart {
            pr.qual.wtank += dc.abs() * v;
        }
        dc
    };
    (c + dc).max(0.0)
}

/// `SGN`: -1 for negative values, else +1.
fn sgn1(x: f64) -> f64 {
    if x < 0.0 { -1.0 } else { 1.0 }
}

fn bulkrate(q: &Quality, c: f64, kb: f64, order: f64) -> f64 {
    let mut c = c;
    if order == 0.0 {
        c = 1.0;
    } else if order < 0.0 {
        let mut c1 = q.climit + sgn1(kb) * c;
        if c1.abs() < TINY {
            c1 = sgn1(c1) * TINY;
        }
        c /= c1;
    } else {
        let c1 = if q.climit == 0.0 {
            c
        } else {
            (sgn1(kb) * (q.climit - c)).max(0.0)
        };
        if order == 1.0 {
            c = c1;
        } else if order == 2.0 {
            c = c1 * c;
        } else {
            c = c1 * pow(c.max(0.0), order - 1.0);
        }
    }
    if c < 0.0 {
        c = 0.0;
    }
    kb * c
}

fn wallrate(pr: &Project, c: f64, d: f64, kw: f64, kf: f64) -> f64 {
    if kw == 0.0 || d == 0.0 {
        return 0.0;
    }
    if pr.qual.wall_order == 0.0 {
        let kf = sgn1(kw) * c * kf;
        let e = pr.units.ucf[Field::Elev as usize];
        let mut kw = kw * (e * e);
        if kf.abs() < kw.abs() {
            kw = kf;
        }
        kw * 4.0 / d
    } else {
        c * kf
    }
}

fn mixtank(pr: &mut Project, n: usize, volin: f64, massin: f64, volout: f64) -> f64 {
    let i = n - pr.net.njuncs;
    let vnet = volin - volout;
    match pr.net.tank[i].mix_model {
        MixModel::Mix1 => tankmix1(pr, i, volin, massin, vnet),
        MixModel::Mix2 => tankmix2(pr, i, volin, massin, vnet),
        MixModel::Fifo => tankmix3(pr, i, volin, massin, vnet),
        MixModel::Lifo => tankmix4(pr, i, volin, massin, vnet),
    }
    pr.net.tank[i].c
}

fn tankmix1(pr: &mut Project, i: usize, vin: f64, win: f64, vnet: f64) {
    let k = pr.net.nlinks + i;
    let s = pr.qual.first[k];
    if s == NIL {
        return;
    }
    let vmax = pr.net.tank[i].vmax;
    let seg = &mut pr.qual.segs[s as usize];
    let vnew = seg.v + vin;
    if vnew > 0.0 {
        seg.c = (seg.c * seg.v + win) / vnew;
    }
    seg.v += vnet;
    seg.v = seg.v.max(0.0);
    let c = seg.c;
    pr.net.tank[i].c = c;
    if seg.v > vmax {
        let over = (seg.v - vmax) * c;
        seg.v = vmax;
        pr.qual.mass.outflow += over;
    }
}

fn tankmix2(pr: &mut Project, i: usize, vin: f64, win: f64, vnet: f64) {
    let k = pr.net.nlinks + i;
    let mz = pr.qual.last[k];
    let sz = pr.qual.first[k];
    if mz == NIL || sz == NIL {
        return;
    }
    let (mz, sz) = (mz as usize, sz as usize);
    let tank = &pr.net.tank[i];
    let vmz = tank.v1frac * tank.vmax;
    let vmax = tank.vmax;
    let segs = &mut pr.qual.segs;
    let mut vt = 0.0;
    if vnet > 0.0 {
        vt = (segs[mz].v + vnet - vmz).max(0.0);
        if vin > 0.0 {
            segs[mz].c = (segs[mz].c * segs[mz].v + win) / (segs[mz].v + vin);
        }
        if vt > 0.0 {
            segs[sz].c = (segs[sz].c * segs[sz].v + segs[mz].c * vt) / (segs[sz].v + vt);
        }
    } else if vnet < 0.0 {
        if segs[sz].v > 0.0 {
            vt = segs[sz].v.min(-vnet);
        }
        if vin + vt > 0.0 {
            segs[mz].c =
                (segs[mz].c * segs[mz].v + win + segs[sz].c * vt) / (segs[mz].v + vin + vt);
        }
    }
    let mut overflow = 0.0;
    if vt > 0.0 {
        if vnet > 0.0 {
            segs[mz].v = vmz;
            segs[sz].v += vt;
            let vsz = vmax - vmz;
            if segs[sz].v > vsz {
                overflow = (segs[sz].v - vsz) * segs[sz].c;
                segs[sz].v = vsz;
            }
        } else {
            segs[sz].v = (segs[sz].v - vt).max(0.0);
            segs[mz].v = vmz + vt + vnet;
        }
    } else {
        segs[mz].v += vnet;
        segs[mz].v = segs[mz].v.min(vmz);
        segs[mz].v = segs[mz].v.max(0.0);
        if vmz - segs[mz].v > 0.0 {
            segs[sz].v = 0.0;
        }
    }
    let c = segs[mz].c;
    pr.qual.mass.outflow += overflow;
    pr.net.tank[i].c = c;
}

fn tankmix3(pr: &mut Project, i: usize, vin: f64, win: f64, vnet: f64) {
    let k = pr.net.nlinks + i;
    if pr.qual.last[k] == NIL || pr.qual.first[k] == NIL {
        return;
    }
    if vin > 0.0 {
        let cin = win / vin;
        let l = pr.qual.last[k] as usize;
        if (pr.qual.segs[l].c - cin).abs() < pr.qual.ctol {
            pr.qual.segs[l].v += vin;
        } else {
            addseg(&mut pr.qual, k, vin, cin);
        }
    }
    let (tv, tvmax) = (pr.net.tank[i].v, pr.net.tank[i].vmax);
    let mut vout = vin - vnet;
    if tv >= tvmax && vnet > 0.0 {
        vout = vin;
    }
    let mut vsum = 0.0;
    let mut wsum = 0.0;
    let q = &mut pr.qual;
    while vout > 0.0 {
        let s = q.first[k];
        if s == NIL {
            break;
        }
        let seg = q.segs[s as usize];
        let mut vseg = seg.v.min(vout);
        if s == q.last[k] {
            vseg = vout;
        }
        vsum += vseg;
        wsum += seg.c * vseg;
        vout -= vseg;
        if vout >= 0.0 && vseg >= seg.v {
            if seg.prev != NIL {
                q.first[k] = seg.prev;
                q.segs[s as usize].prev = q.free;
                q.free = s;
            }
        } else {
            q.segs[s as usize].v -= vseg;
        }
    }
    let c = if vsum > 0.0 {
        wsum / vsum
    } else if q.first[k] == NIL {
        0.0
    } else {
        q.segs[q.first[k] as usize].c
    };
    pr.net.tank[i].c = c;
    if tv >= tvmax && vnet > 0.0 {
        pr.qual.mass.outflow += vnet * c;
    }
}

fn tankmix4(pr: &mut Project, i: usize, vin: f64, win: f64, mut vnet: f64) {
    let k = pr.net.nlinks + i;
    if pr.qual.last[k] == NIL || pr.qual.first[k] == NIL {
        return;
    }
    let cin = if vin > 0.0 { win / vin } else { 0.0 };
    let (tv, tvmax) = (pr.net.tank[i].v, pr.net.tank[i].vmax);
    pr.net.tank[i].c = pr.qual.segs[pr.qual.last[k] as usize].c;
    let l = pr.qual.last[k] as usize;
    if vnet > 0.0 {
        if (pr.qual.segs[l].c - cin).abs() < pr.qual.ctol {
            pr.qual.segs[l].v += vnet;
        } else {
            addseg(&mut pr.qual, k, vnet, cin);
        }
        pr.net.tank[i].c = pr.qual.segs[pr.qual.last[k] as usize].c;
        if tv >= tvmax {
            let mut wsum = 0.0;
            let q = &mut pr.qual;
            while vnet > 0.0 {
                let s = q.first[k];
                if s == NIL {
                    break;
                }
                let seg = q.segs[s as usize];
                let mut vseg = seg.v.min(vnet);
                if s == q.last[k] {
                    vseg = vnet;
                }
                wsum += seg.c * vseg;
                vnet -= vseg;
                if vnet >= 0.0 && vseg >= seg.v {
                    if seg.prev != NIL {
                        q.first[k] = seg.prev;
                        q.segs[s as usize].prev = q.free;
                        q.free = s;
                    }
                } else {
                    q.segs[s as usize].v -= vseg;
                }
            }
            q.mass.outflow += wsum;
        }
    } else if vnet < 0.0 {
        let mut vsum = 0.0;
        let mut wsum = 0.0;
        vnet = -vnet;
        reversesegs(pr, k);
        let q = &mut pr.qual;
        while vnet > 0.0 {
            let s = q.first[k];
            if s == NIL {
                break;
            }
            let seg = q.segs[s as usize];
            let mut vseg = seg.v.min(vnet);
            if s == q.last[k] {
                vseg = vnet;
            }
            vsum += vseg;
            wsum += seg.c * vseg;
            vnet -= vseg;
            if vnet >= 0.0 && vseg >= seg.v {
                if seg.prev != NIL {
                    q.first[k] = seg.prev;
                    q.segs[s as usize].prev = q.free;
                    q.free = s;
                }
            } else {
                q.segs[s as usize].v -= vseg;
            }
        }
        reversesegs(pr, k);
        pr.net.tank[i].c = (wsum + win) / (vsum + vin);
    }
}

/// `buildadjlists` (project.c): for each node, (opposite node, link) with each link
/// prepended to both end nodes' lists, as EPANET's linked lists hold them.
pub fn buildadjlists(net: &Network) -> Vec<Vec<(usize, usize)>> {
    let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); net.nnodes + 1];
    for k in 1..=net.nlinks {
        let (i, j) = (net.link[k].n1, net.link[k].n2);
        adj[i].push((j, k));
        adj[j].push((i, k));
    }
    for list in &mut adj {
        list.reverse();
    }
    adj
}
