// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (epanet.c, project.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! The toolkit's setters: element properties, demands, patterns, curves, simple
//! controls, options, times and quality settings, ported from `epanet.c` with the
//! `project.c` helpers they use.

use super::*;
use crate::coeffs::resistcoeff;
use crate::quality::{L_PER_FT3, Source, SourceType};
use crate::types::{Control, ControlType, Curve, Demand, Pattern};

/// `ROUND`
fn iround(x: f64) -> i32 {
    round(x) as i32
}

/// `namevalid`: 1 to 31 bytes, no space or semicolon, not starting with a quote.
pub(super) fn namevalid(name: &str) -> bool {
    let n = name.len();
    (1..=MAXID).contains(&n) && !name.contains([' ', ';']) && !name.starts_with('"')
}

fn adjustpattern(pat: &mut usize, index: usize) {
    if *pat == index {
        *pat = 0;
    } else if *pat > index {
        *pat -= 1;
    }
}

/// `adjustpatterns` (project.c): references after pattern `index` is deleted.
fn adjustpatterns(net: &mut Network, index: usize) {
    for j in 1..=net.nnodes {
        for d in &mut net.node[j].d {
            adjustpattern(&mut d.pat, index);
        }
        if let Some(s) = &mut net.node[j].source {
            adjustpattern(&mut s.pat, index);
        }
    }
    for j in 1..=net.ntanks {
        adjustpattern(&mut net.tank[j].pat, index);
    }
    for j in 1..=net.npumps {
        adjustpattern(&mut net.pump[j].upat, index);
        adjustpattern(&mut net.pump[j].epat, index);
    }
}

/// `adjustcurves` (project.c): references after curve `index` is deleted.
fn adjustcurves(net: &mut Network, index: usize) {
    for j in 1..=net.ntanks {
        adjustpattern(&mut net.tank[j].vcurve, index);
    }
    for j in 1..=net.npumps {
        adjustpattern(&mut net.pump[j].hcurve, index);
        adjustpattern(&mut net.pump[j].ecurve, index);
    }
    for j in 1..=net.nvalves {
        let k = net.valve[j].link;
        if net.link[k].link_type == LinkType::Pcv {
            let mut curve = net.valve[j].curve;
            if curve > 0 {
                adjustpattern(&mut curve, index);
                net.valve[j].curve = curve;
                if curve == 0 {
                    net.link[k].kc = 0.0;
                }
            }
        }
        if net.link[k].link_type == LinkType::Gpv {
            let mut curve = net.link[k].kc as usize;
            adjustpattern(&mut curve, index);
            net.link[k].kc = curve as f64;
        }
    }
}

/// `valvecheck` (project.c): whether a valve of a type may join nodes `j1` and `j2`.
pub(super) fn valvecheck(net: &Network, index: usize, t: LinkType, j1: usize, j2: usize) -> i32 {
    use LinkType::{Fcv, Prv, Psv};
    if t == Prv || t == Psv || t == Fcv {
        if j1 > net.njuncs || j2 > net.njuncs {
            return 219;
        }
        for k in 1..=net.nvalves {
            let v = &net.valve[k];
            if v.link == index {
                continue;
            }
            let link = &net.link[v.link];
            let (vj1, vj2, vt) = (link.n1, link.n2, link.link_type);
            if vt == Prv && t == Prv && (vj2 == j2 || vj2 == j1 || vj1 == j2) {
                return 220;
            }
            if vt == Psv && t == Psv && (vj1 == j1 || vj1 == j2 || vj2 == j1) {
                return 220;
            }
            if (vt == Psv && t == Prv && vj1 == j2) || (vt == Prv && t == Psv && vj2 == j1) {
                return 220;
            }
            if (vt == Fcv && t == Psv && vj2 == j1)
                || (vt == Fcv && t == Prv && vj1 == j2)
                || (vt == Psv && t == Fcv && vj1 == j2)
                || (vt == Prv && t == Fcv && vj2 == j1)
            {
                return 220;
            }
        }
    }
    0
}

pub(super) fn link_type(code: i32) -> Option<LinkType> {
    Some(match code {
        0 => LinkType::CvPipe,
        1 => LinkType::Pipe,
        2 => LinkType::Pump,
        3 => LinkType::Prv,
        4 => LinkType::Psv,
        5 => LinkType::Pbv,
        6 => LinkType::Fcv,
        7 => LinkType::Tcv,
        8 => LinkType::Gpv,
        9 => LinkType::Pcv,
        _ => return None,
    })
}

/// `changevalvetype` (project.c)
fn changevalvetype(pr: &mut Project, index: usize, t: LinkType) -> i32 {
    let ucf = pr.units.ucf;
    let link = &pr.net.link[index];
    if link.link_type <= LinkType::Pump {
        return 264;
    }
    let e = valvecheck(&pr.net, index, t, link.n1, link.n2);
    if e != 0 {
        return e;
    }
    let mut setting = link.init_setting;
    match link.link_type {
        LinkType::Fcv => setting *= ucf[Field::Flow as usize],
        LinkType::Prv | LinkType::Psv | LinkType::Pbv => setting *= ucf[Field::Pressure as usize],
        LinkType::Gpv => setting = 0.0,
        _ => {}
    }
    match t {
        LinkType::Fcv => setting /= ucf[Field::Flow as usize],
        LinkType::Prv | LinkType::Psv | LinkType::Pbv => setting /= ucf[Field::Pressure as usize],
        _ => {}
    }
    if t == LinkType::Gpv {
        setting = 0.0;
    }
    if t == LinkType::Pcv {
        setting = min_c(setting, 100.0);
    }
    let link = &mut pr.net.link[index];
    link.kc = setting;
    link.init_setting = setting;
    link.link_type = t;
    0
}

/// `setcontrol` (project.c): a control from the toolkit's arguments.
fn makecontrol(
    pr: &Project,
    control_type: i32,
    link_index: usize,
    setting: f64,
    mut node_index: i32,
    level: f64,
) -> Result<Control, i32> {
    let net = &pr.net;
    let ucf = |f: Field| pr.units.ucf[f as usize];
    let lt = net.link[link_index].link_type;
    if lt == LinkType::CvPipe {
        return Err(207);
    }
    let ctype = match control_type {
        0 => ControlType::LowLevel,
        1 => ControlType::HiLevel,
        2 => ControlType::Timer,
        3 => ControlType::TimeOfDay,
        _ => return Err(251),
    };
    if matches!(ctype, ControlType::LowLevel | ControlType::HiLevel) {
        if node_index < 1 || node_index as usize > net.nnodes {
            return Err(203);
        }
    } else {
        node_index = 0;
    }
    let mut status = Status::Active;
    let mut s = MISSING;
    if setting == SET_OPEN {
        status = Status::Open;
        if lt == LinkType::Pump {
            s = 1.0;
        }
        if lt == LinkType::Gpv {
            s = net.link[link_index].kc;
        }
    } else if setting == SET_CLOSED {
        status = Status::Closed;
        if lt == LinkType::Pump {
            s = 0.0;
        }
        if lt == LinkType::Gpv {
            s = net.link[link_index].kc;
        }
    } else {
        s = setting;
        match lt {
            LinkType::Pipe | LinkType::Pump => {
                if s < 0.0 {
                    return Err(202);
                } else if s == 0.0 {
                    status = Status::Closed;
                } else {
                    status = Status::Open;
                }
            }
            LinkType::Prv | LinkType::Psv | LinkType::Pbv => s /= ucf(Field::Pressure),
            LinkType::Fcv => s /= ucf(Field::Flow),
            LinkType::Gpv => {
                if s == 0.0 {
                    status = Status::Closed;
                } else if s == 1.0 {
                    status = Status::Open;
                } else {
                    return Err(202);
                }
                s = net.link[link_index].kc;
            }
            _ => {}
        }
    }
    let mut t = 0;
    let mut lvl = 0.0;
    let n = node_index as usize;
    if matches!(ctype, ControlType::LowLevel | ControlType::HiLevel) {
        lvl = if n > net.njuncs {
            net.node[n].el + level / ucf(Field::Elev)
        } else {
            net.node[n].el + level / ucf(Field::Pressure)
        };
    } else {
        t = level as i64;
        if t < 0 {
            return Err(202);
        }
    }
    Ok(Control {
        link: link_index,
        node: n,
        time: t,
        grade: lvl,
        setting: s,
        status,
        control_type: ctype,
        is_enabled: true,
    })
}

impl Toolkit {
    pub(super) fn om(&mut self) -> Option<&mut Open> {
        self.p.as_deref_mut()
    }

    // ---- Project ---------------------------------------------------------------------

    /// `EN_settitle`
    pub fn settitle(&mut self, line1: &str, line2: &str, line3: &str) -> i32 {
        let Some(o) = self.om() else { return 102 };
        for (k, l) in [line1, line2, line3].into_iter().enumerate() {
            let mut s = l.to_string();
            truncate_bytes(&mut s, TITLELEN);
            o.meta.title[k] = s;
        }
        0
    }

    /// `EN_setcomment` (`setcomment`)
    pub fn setcomment(&mut self, object: i32, index: i32, comment: &str) -> i32 {
        let Some(o) = self.om() else { return 251 };
        let net = &o.pr.net;
        let i = index as usize;
        let slot = match object {
            EN_NODE if index >= 1 && i <= net.nnodes => &mut o.meta.node_comment[i],
            EN_LINK if index >= 1 && i <= net.nlinks => &mut o.meta.link_comment[i],
            EN_TIMEPAT if index >= 1 && i < net.pattern.len() => &mut o.meta.pattern_comment[i],
            EN_CURVE if index >= 1 && i < net.curve.len() => &mut o.meta.curve_comment[i],
            _ => return 251,
        };
        *slot = xstrcpy(comment, MAXMSG);
        0
    }

    /// `EN_settag` (`settag`)
    pub fn settag(&mut self, object: i32, index: i32, tag: &str) -> i32 {
        let Some(o) = self.om() else { return 251 };
        let net = &o.pr.net;
        let i = index as usize;
        let slot = match object {
            EN_NODE if index >= 1 && i <= net.nnodes => &mut o.meta.node_tag[i],
            EN_LINK if index >= 1 && i <= net.nlinks => &mut o.meta.link_tag[i],
            _ => return 251,
        };
        *slot = xstrcpy(tag, MAXMSG);
        0
    }

    // ---- Options ---------------------------------------------------------------------

    /// `EN_setoption`
    pub fn setoption(&mut self, option: i32, value: f64) -> i32 {
        if !self.is_open() {
            return 102;
        }
        let njuncs = self.o().map_or(0, |o| o.pr.net.njuncs);
        if option == EN_EMITEXPON && value > 0.0 {
            // The new exponent rescales every emitter, read through the getter.
            let (qucf, pucf) = {
                let Some(o) = self.o() else { return 102 };
                (
                    o.pr.units.ucf[Field::Flow as usize],
                    o.pr.units.ucf[Field::Pressure as usize],
                )
            };
            let n = 1.0 / value;
            let ucf = pow(qucf, n) / pucf;
            for i in 1..=njuncs {
                let mut ke = 0.0;
                let j = self.getnodevalue(i as i32, EN_EMITTER, &mut ke);
                if j == 0
                    && ke > 0.0
                    && let Some(o) = self.om()
                {
                    o.pr.net.node[i].ke = ucf / pow(ke, n);
                }
            }
        }
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        if option == EN_UNBALANCED {
            pr.hyd.extra_iter = value as i32;
            if pr.hyd.extra_iter < 0 {
                pr.hyd.extra_iter = -1;
            }
            return 0;
        }
        if value < 0.0 {
            return 213;
        }
        let npats = pr.net.pattern.len() - 1;
        let ucf = pr.units.ucf;
        match option {
            EN_TRIALS => {
                if value < 1.0 {
                    return 213;
                }
                pr.hyd.max_iter = value as i32;
            }
            EN_ACCURACY => {
                if !(1.0e-8..=1.0e-1).contains(&value) {
                    return 213;
                }
                pr.hyd.hacc = value;
            }
            EN_TOLERANCE => pr.qual.ctol = value / ucf[Field::Quality as usize],
            EN_EMITEXPON => {
                if value <= 0.0 {
                    return 213;
                }
                pr.hyd.qexp = 1.0 / value;
            }
            EN_DEMANDMULT => pr.hyd.dmult = value,
            EN_HEADERROR => pr.hyd.head_error_limit = value / ucf[Field::Head as usize],
            EN_FLOWCHANGE => pr.hyd.flow_change_limit = value / ucf[Field::Flow as usize],
            EN_HEADLOSSFORM => {
                if o.open_h {
                    return 262;
                }
                let i = iround(value);
                pr.hyd.formflag = match i {
                    0 => Formula::Hw,
                    1 => Formula::Dw,
                    2 => Formula::Cm,
                    _ => return 213,
                };
                pr.hyd.hexp = if pr.hyd.formflag == Formula::Hw {
                    1.852
                } else {
                    2.0
                };
            }
            EN_GLOBALEFFIC => {
                if value <= 1.0 || value > 100.0 {
                    return 213;
                }
                pr.hyd.epump = value;
            }
            EN_GLOBALPRICE => pr.hyd.ecost = value,
            EN_GLOBALPATTERN => {
                let pat = iround(value);
                if pat < 0 || pat as usize > npats {
                    return 205;
                }
                pr.hyd.epat = pat as usize;
            }
            EN_DEMANDCHARGE => pr.hyd.dcost = value,
            EN_SP_GRAVITY => {
                if value <= 0.0 {
                    return 213;
                }
                if matches!(
                    pr.units.pressflag,
                    PressUnits::Psi | PressUnits::Kpa | PressUnits::Bar
                ) {
                    pr.units.ucf[Field::Pressure as usize] *= value / pr.hyd.sp_grav;
                }
                pr.hyd.sp_grav = value;
            }
            EN_SP_VISCOS => {
                if value <= 0.0 {
                    return 213;
                }
                pr.hyd.viscos = value * VISCOS;
            }
            EN_CHECKFREQ => pr.hyd.check_freq = value as i32,
            EN_MAXCHECK => pr.hyd.max_check = value as i32,
            EN_DAMPLIMIT => pr.hyd.damp_limit = value,
            EN_SP_DIFFUS => pr.qual.diffus = value * DIFFUS,
            EN_BULKORDER => pr.qual.bulk_order = value,
            EN_WALLORDER => {
                if value == 0.0 || value == 1.0 {
                    pr.qual.wall_order = value;
                } else {
                    return 213;
                }
            }
            EN_TANKORDER => pr.qual.tank_order = value,
            EN_CONCENLIMIT => pr.qual.climit = value / ucf[Field::Quality as usize],
            EN_DEMANDPATTERN => {
                let pat = iround(value);
                if pat < 0 || pat as usize > npats {
                    return 205;
                }
                pr.hyd.def_pat = pat as usize;
            }
            EN_EMITBACKFLOW => {
                if value == 0.0 || value == 1.0 {
                    pr.hyd.emit_back_flag = value != 0.0;
                } else {
                    return 213;
                }
            }
            EN_PRESS_UNITS => {
                let unit = iround(value);
                pr.units.pressflag = match unit {
                    0 => PressUnits::Psi,
                    1 => PressUnits::Kpa,
                    2 => PressUnits::Meters,
                    3 => PressUnits::Bar,
                    4 => PressUnits::Feet,
                    _ => return 205,
                };
                let old = pr.units.ucf;
                crate::input::initunits(pr);
                let f = |x: Field| pr.units.ucf[x as usize] / old[x as usize];
                let (dcf, pcf, hcf, qcf) = (
                    f(Field::Demand),
                    f(Field::Pressure),
                    f(Field::Head),
                    f(Field::Flow),
                );
                crate::rules::updateruleunits(pr, dcf, pcf, hcf, qcf);
            }
            EN_STATUS_REPORT => {
                let i = iround(value);
                pr.rpt.statflag = match i {
                    0 => crate::report::Statflag::No,
                    1 => crate::report::Statflag::Yes,
                    2 => crate::report::Statflag::Full,
                    _ => return 213,
                };
            }
            _ => return 251,
        }
        0
    }

    /// `EN_setflowunits`
    pub fn setflowunits(&mut self, units: i32) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        let old = pr.units.ucf;
        let flow = match units {
            0 => FlowUnits::Cfs,
            1 => FlowUnits::Gpm,
            2 => FlowUnits::Mgd,
            3 => FlowUnits::Imgd,
            4 => FlowUnits::Afd,
            5 => FlowUnits::Lps,
            6 => FlowUnits::Lpm,
            7 => FlowUnits::Mld,
            8 => FlowUnits::Cmh,
            9 => FlowUnits::Cmd,
            10 => FlowUnits::Cms,
            // EPANET stores any code; an unknown one is US units with a factor of 1.
            _ => return 251,
        };
        pr.units.flowflag = flow;
        pr.units.unitsflag = if units >= 5 {
            UnitsType::Si
        } else {
            UnitsType::Us
        };
        crate::input::initunits(pr);
        let u = pr.units.ucf;
        let f = |x: Field| u[x as usize] / old[x as usize];
        let (dcf, pcf, hcf, qcf) = (
            f(Field::Demand),
            f(Field::Pressure),
            f(Field::Head),
            f(Field::Flow),
        );
        crate::rules::updateruleunits(pr, dcf, pcf, hcf, qcf);
        // assigncurvetypes, then convert each curve's points to the new units.
        let net = &pr.net;
        for i in 1..=net.npumps {
            let p = &net.pump[i];
            if p.hcurve > 0 {
                o.curve_type[p.hcurve] = EN_PUMP_CURVE;
            }
            if p.ecurve > 0 {
                o.curve_type[p.ecurve] = EN_EFFIC_CURVE;
            }
        }
        for i in 1..=net.ntanks {
            if net.tank[i].vcurve > 0 {
                o.curve_type[net.tank[i].vcurve] = EN_VOLUME_CURVE;
            }
        }
        for i in 1..=net.nvalves {
            let v = &net.valve[i];
            match net.link[v.link].link_type {
                LinkType::Pcv if v.curve > 0 => o.curve_type[v.curve] = EN_VALVE_CURVE,
                LinkType::Gpv if v.curve > 0 => o.curve_type[v.curve] = EN_HLOSS_CURVE,
                _ => {}
            }
        }
        let (qf, vf, hf, ef) = (
            old[Field::Flow as usize],
            old[Field::Volume as usize],
            old[Field::Head as usize],
            old[Field::Elev as usize],
        );
        for i in 1..pr.net.curve.len() {
            let (xf, yf) = match o.curve_type[i] {
                EN_VOLUME_CURVE => (ef / u[Field::Elev as usize], vf / u[Field::Volume as usize]),
                EN_HLOSS_CURVE | EN_PUMP_CURVE => {
                    (qf / u[Field::Flow as usize], hf / u[Field::Head as usize])
                }
                EN_EFFIC_CURVE => (qf / u[Field::Flow as usize], 1.0),
                _ => (1.0, 1.0),
            };
            let c = &mut pr.net.curve[i];
            for x in &mut c.x {
                *x /= xf;
            }
            for y in &mut c.y {
                *y /= yf;
            }
        }
        0
    }

    /// `EN_settimeparam`
    pub fn settimeparam(&mut self, param: i32, value: i64) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if value < 0 {
            return 213;
        }
        let t = &mut o.pr.times;
        match param {
            EN_DURATION => {
                t.dur = value;
                if t.rstart > t.dur {
                    t.rstart = 0;
                }
            }
            EN_HYDSTEP => {
                if value == 0 {
                    return 213;
                }
                t.hstep = value;
                t.hstep = t.pstep.min(t.hstep);
                t.hstep = t.rstep.min(t.hstep);
                t.qstep = t.qstep.min(t.hstep);
            }
            EN_QUALSTEP => {
                if value == 0 {
                    return 213;
                }
                t.qstep = value;
                t.qstep = t.qstep.min(t.hstep);
            }
            EN_PATTERNSTEP => {
                if value == 0 {
                    return 213;
                }
                t.pstep = value;
                if t.hstep > t.pstep {
                    t.hstep = t.pstep;
                }
            }
            EN_PATTERNSTART => t.pstart = value,
            EN_REPORTSTEP => {
                if value == 0 {
                    return 213;
                }
                t.rstep = value;
                if t.hstep > t.rstep {
                    t.hstep = t.rstep;
                }
            }
            EN_REPORTSTART => {
                if t.rstart > t.dur {
                    return 213;
                }
                t.rstart = value;
            }
            EN_RULESTEP => {
                if value == 0 {
                    return 213;
                }
                t.rulestep = value;
                t.rulestep = t.rulestep.min(t.hstep);
            }
            EN_STATISTIC => {
                use crate::report::Tstat;
                o.pr.rpt.tstatflag = match value {
                    0 => Tstat::Series,
                    1 => Tstat::Avg,
                    2 => Tstat::Min,
                    3 => Tstat::Max,
                    4 => Tstat::Range,
                    _ => return 213,
                };
            }
            EN_HTIME => t.htime = value,
            EN_QTIME => t.qtime = value,
            EN_STARTTIME => {
                if value > SECPERDAY {
                    return 213;
                }
                t.tstart = value;
            }
            _ => return 251,
        }
        0
    }

    /// `EN_setqualtype`
    pub fn setqualtype(
        &mut self,
        qual_type: i32,
        chem_name: &str,
        chem_units: &str,
        trace_node: &str,
    ) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if o.open_q {
            return 262;
        }
        let qualflag = match qual_type {
            0 => QualType::None,
            1 => QualType::Chem,
            2 => QualType::Age,
            3 => QualType::Trace,
            _ => return 251,
        };
        let mut trace_index = 0;
        if qualflag == QualType::Trace {
            trace_index = Self::findnode(o, trace_node);
            if trace_index == 0 {
                return 212;
            }
        }
        let pr = &mut o.pr;
        let q = &mut pr.qual;
        q.trace_node = trace_index;
        let old = q.qualflag;
        q.qualflag = qualflag;
        let quality = Field::Quality as usize;
        q.ctol *= pr.units.ucf[quality];
        let mut ccf = 1.0;
        let cut = |s: &str| {
            let mut s = s.to_string();
            truncate_bytes(&mut s, MAXID);
            s
        };
        match qualflag {
            QualType::Chem => {
                q.chem_name = cut(chem_name);
                q.chem_units = cut(chem_units);
                ccf = 1.0 / L_PER_FT3;
            }
            QualType::Trace => {
                q.chem_name = "TRACE".into();
                q.chem_units = "% from".into();
            }
            QualType::Age => {
                q.chem_name = "AGE".into();
                q.chem_units = "hrs".into();
            }
            QualType::None => {}
        }
        crate::report::setqualityunits(pr);
        if matches!(qualflag, QualType::Age | QualType::Trace) && old == QualType::Chem {
            for i in 1..=pr.net.nnodes {
                pr.net.node[i].c0 *= pr.units.ucf[quality];
            }
        }
        pr.units.ucf[quality] = ccf;
        pr.units.ucf[Field::LinkQual as usize] = ccf;
        pr.units.ucf[Field::ReactRate as usize] = ccf;
        pr.qual.ctol /= pr.units.ucf[quality];
        0
    }

    // ---- Nodes -----------------------------------------------------------------------

    /// `EN_setnodeid`
    pub fn setnodeid(&mut self, index: i32, new_id: &str) -> i32 {
        let Some(o) = self.om() else { return 203 };
        if index <= 0 || index as usize > o.pr.net.nnodes {
            return 203;
        }
        if !namevalid(new_id) {
            return 252;
        }
        if Self::findnode(o, new_id) > 0 {
            return 215;
        }
        o.pr.net.node[index as usize].id = new_id.to_string();
        0
    }

    /// `EN_setnodevalue`
    pub fn setnodevalue(&mut self, index: i32, property: i32, value: f64) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        if index <= 0 || index as usize > pr.net.nnodes {
            return 203;
        }
        let i = index as usize;
        let njuncs = pr.net.njuncs;
        let npats = pr.net.pattern.len() - 1;
        let ucf_a = pr.units.ucf;
        let ucf = |f: Field| ucf_a[f as usize];
        let mut value = value;
        match property {
            EN_ELEVATION => {
                if i <= njuncs {
                    pr.net.node[i].el = value / ucf(Field::Elev);
                } else {
                    value = value / ucf(Field::Elev) - pr.net.node[i].el;
                    let t = &mut pr.net.tank[i - njuncs];
                    t.h0 += value;
                    t.hmin += value;
                    t.hmax += value;
                    pr.net.node[i].el += value;
                    pr.hyd.node_head[i] += value;
                }
            }
            EN_BASEDEMAND => {
                if i <= njuncs {
                    let q = value / ucf(Field::Flow);
                    if let Some(d) = pr.net.node[i].d.first_mut() {
                        d.base = q;
                    }
                }
            }
            EN_PATTERN => {
                let j = iround(value);
                if j < 0 || j as usize > npats {
                    return 205;
                }
                if i <= njuncs {
                    if let Some(d) = pr.net.node[i].d.first_mut() {
                        d.pat = j as usize;
                    }
                } else {
                    pr.net.tank[i - njuncs].pat = j as usize;
                }
            }
            EN_EMITTER => {
                if i > njuncs {
                    return 0;
                }
                if value < 0.0 {
                    return 209;
                }
                if value > 0.0 {
                    let ecf = if pr.units.unitsflag == UnitsType::Us {
                        PSI_PER_FT * pr.hyd.sp_grav
                    } else {
                        M_PER_FT
                    };
                    value = pow(ucf(Field::Flow) / value, pr.hyd.qexp) / ecf;
                }
                pr.net.node[i].ke = value;
                if pr.hyd.emitter_flow[i] == 0.0 {
                    pr.hyd.emitter_flow[i] = 1.0;
                }
            }
            EN_INITQUAL => {
                if value < 0.0 {
                    return 209;
                }
                pr.net.node[i].c0 = value / ucf(Field::Quality);
                if i > njuncs {
                    pr.net.tank[i - njuncs].c = pr.net.node[i].c0;
                }
            }
            EN_SOURCEQUAL | EN_SOURCETYPE | EN_SOURCEPAT => {
                if value < 0.0 {
                    return 209;
                }
                let s = pr.net.node[i].source.get_or_insert(Source {
                    kind: SourceType::Concen,
                    c0: 0.0,
                    pat: 0,
                    smass: 0.0,
                });
                if property == EN_SOURCEQUAL {
                    s.c0 = value;
                } else if property == EN_SOURCEPAT {
                    let j = iround(value);
                    if j < 0 || j as usize > npats {
                        return 205;
                    }
                    s.pat = j as usize;
                } else {
                    s.kind = match iround(value) {
                        0 => SourceType::Concen,
                        1 => SourceType::Mass,
                        2 => SourceType::Setpoint,
                        3 => SourceType::FlowPaced,
                        _ => return 251,
                    };
                }
            }
            EN_TANKLEVEL => {
                if i <= njuncs {
                    return 263;
                }
                let j = i - njuncs;
                if pr.net.tank[j].a == 0.0 {
                    let h0 = value / ucf(Field::Elev);
                    let t = &mut pr.net.tank[j];
                    t.h0 = h0;
                    t.hmin = h0;
                    t.hmax = h0;
                    pr.net.node[i].el = h0;
                    pr.hyd.node_head[i] = h0;
                } else {
                    let value = pr.net.node[i].el + value / ucf(Field::Elev);
                    if value > pr.net.tank[j].hmax || value < pr.net.tank[j].hmin {
                        return 225;
                    }
                    pr.net.tank[j].h0 = value;
                    let v0 = hydraul::tankvolume(pr, j, value);
                    pr.net.tank[j].v0 = v0;
                    pr.net.tank[j].v = v0;
                    pr.hyd.node_head[i] = value;
                }
            }
            EN_TANKDIAM => {
                if value <= 0.0 {
                    return 209;
                }
                if i <= njuncs {
                    return 263;
                }
                let j = i - njuncs;
                if pr.net.tank[j].a == 0.0 {
                    return 263;
                }
                let d = value / ucf(Field::Elev);
                pr.net.tank[j].a = PI * (d * d) / 4.0;
                if pr.net.tank[j].vcurve > 0 {
                    pr.net.tank[j].vcurve = 0;
                    let t = &pr.net.tank[j];
                    pr.net.tank[j].vmin = t.a * (t.hmin - pr.net.node[i].el);
                }
                let (h0, hmax) = (pr.net.tank[j].h0, pr.net.tank[j].hmax);
                pr.net.tank[j].v0 = hydraul::tankvolume(pr, j, h0);
                pr.net.tank[j].vmax = hydraul::tankvolume(pr, j, hmax);
            }
            EN_MINVOLUME => {
                if value < 0.0 {
                    return 209;
                }
                if i <= njuncs {
                    return 263;
                }
                let j = i - njuncs;
                if pr.net.tank[j].a == 0.0 {
                    return 263;
                }
                let c = pr.net.tank[j].vcurve;
                if c > 0 {
                    if value < pr.net.curve[c].y.first().copied().unwrap_or(0.0) {
                        return 225;
                    }
                    let v = value / ucf(Field::Volume);
                    let h = hydraul::tankgrade(pr, j, v);
                    if h > pr.net.tank[j].h0 || h > pr.net.tank[j].hmax {
                        return 225;
                    }
                    pr.net.tank[j].hmin = h;
                    pr.net.tank[j].vmin = v;
                } else {
                    let t = &pr.net.tank[j];
                    let vmin = if value == 0.0 {
                        t.a * (t.hmin - pr.net.node[i].el)
                    } else {
                        value / ucf(Field::Volume)
                    };
                    pr.net.tank[j].vmin = vmin;
                    let (h0, hmax) = (pr.net.tank[j].h0, pr.net.tank[j].hmax);
                    pr.net.tank[j].v0 = hydraul::tankvolume(pr, j, h0);
                    pr.net.tank[j].vmax = hydraul::tankvolume(pr, j, hmax);
                }
            }
            EN_VOLCURVE => {
                let c = iround(value);
                if c <= 0 || c as usize >= pr.net.curve.len() {
                    return 205;
                }
                if i <= njuncs {
                    return 263;
                }
                let j = i - njuncs;
                if pr.net.tank[j].a == 0.0 {
                    return 263;
                }
                let c = c as usize;
                let el = pr.net.node[i].el;
                let curve = &pr.net.curve[c];
                let n = curve.x.len().saturating_sub(1);
                let (x0, xn) = (
                    curve.x.first().copied().unwrap_or(0.0),
                    curve.x.get(n).copied().unwrap_or(0.0),
                );
                let (y0, yn) = (
                    curve.y.first().copied().unwrap_or(0.0),
                    curve.y.get(n).copied().unwrap_or(0.0),
                );
                if (pr.net.tank[j].hmin - el) * ucf(Field::Elev) < x0 {
                    return 225;
                }
                if (pr.net.tank[j].hmax - el) * ucf(Field::Elev) > xn {
                    return 225;
                }
                pr.net.tank[j].vcurve = c;
                let (hmin, h0, hmax) =
                    (pr.net.tank[j].hmin, pr.net.tank[j].h0, pr.net.tank[j].hmax);
                pr.net.tank[j].vmin = hydraul::tankvolume(pr, j, hmin);
                pr.net.tank[j].v0 = hydraul::tankvolume(pr, j, h0);
                pr.net.tank[j].vmax = hydraul::tankvolume(pr, j, hmax);
                pr.net.tank[j].a = (yn - y0) / (xn - x0);
            }
            EN_MINLEVEL => {
                if value < 0.0 {
                    return 209;
                }
                if i <= njuncs {
                    return 263;
                }
                let j = i - njuncs;
                if pr.net.tank[j].a == 0.0 {
                    return 263;
                }
                let h = value / ucf(Field::Elev) + pr.net.node[i].el;
                if h >= pr.net.tank[j].hmax || h > pr.net.tank[j].h0 {
                    return 225;
                }
                let c = pr.net.tank[j].vcurve;
                if c > 0 {
                    if value < pr.net.curve[c].x.first().copied().unwrap_or(0.0) {
                        return 225;
                    }
                    pr.net.tank[j].vmin = hydraul::tankvolume(pr, j, h);
                }
                pr.net.tank[j].hmin = h;
            }
            EN_MAXLEVEL => {
                if value <= 0.0 {
                    return 209;
                }
                if i <= njuncs {
                    return 263;
                }
                let j = i - njuncs;
                if pr.net.tank[j].a == 0.0 {
                    return 263;
                }
                let h = value / ucf(Field::Elev) + pr.net.node[i].el;
                if h < pr.net.tank[j].hmin || h < pr.net.tank[j].h0 {
                    return 225;
                }
                let c = pr.net.tank[j].vcurve;
                if c > 0 && value > pr.net.curve[c].x.last().copied().unwrap_or(0.0) {
                    return 225;
                }
                pr.net.tank[j].hmax = h;
                pr.net.tank[j].vmax = hydraul::tankvolume(pr, j, h);
            }
            EN_MIXMODEL => {
                let j = iround(value);
                if i <= njuncs {
                    return 263;
                }
                let m = match j {
                    0 => crate::quality::MixModel::Mix1,
                    1 => crate::quality::MixModel::Mix2,
                    2 => crate::quality::MixModel::Fifo,
                    3 => crate::quality::MixModel::Lifo,
                    _ => return 251,
                };
                if pr.net.tank[i - njuncs].a > 0.0 {
                    pr.net.tank[i - njuncs].mix_model = m;
                }
            }
            EN_MIXFRACTION => {
                if i <= njuncs {
                    return 263;
                }
                if !(0.0..=1.0).contains(&value) {
                    return 209;
                }
                if pr.net.tank[i - njuncs].a > 0.0 {
                    pr.net.tank[i - njuncs].v1frac = value;
                }
            }
            EN_TANK_KBULK => {
                if i <= njuncs {
                    return 263;
                }
                if pr.net.tank[i - njuncs].a > 0.0 {
                    pr.net.tank[i - njuncs].kb = value / SECPERDAY_F;
                    pr.qual.reactflag = true;
                }
            }
            EN_CANOVERFLOW => {
                if pr.net.node[i].node_type != NodeType::Tank {
                    return 263;
                }
                pr.net.tank[i - njuncs].can_overflow = value != 0.0;
            }
            _ => return 251,
        }
        0
    }

    /// `EN_setjuncdata`
    pub fn setjuncdata(&mut self, index: i32, elev: f64, dmnd: f64, dmndpat: &str) -> i32 {
        if !self.is_open() {
            return 102;
        }
        let mut pat = 0;
        if !dmndpat.is_empty() && self.getpatternindex(dmndpat, &mut pat) > 0 {
            if self
                .o()
                .is_some_and(|o| index <= 0 || index as usize > o.pr.net.njuncs)
            {
                return 203;
            }
            return 205;
        }
        let Some(o) = self.om() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.njuncs {
            return 203;
        }
        let i = index as usize;
        let pr = &mut o.pr;
        let base = dmnd / pr.units.ucf[Field::Flow as usize];
        let node = &mut pr.net.node[i];
        if let Some(d) = node.d.first_mut() {
            d.base = base;
            d.pat = pat as usize;
        } else {
            node.d.push(Demand {
                base,
                pat: pat as usize,
            });
            o.meta.demand_name[i].push(None);
        }
        pr.net.node[i].el = elev / pr.units.ucf[Field::Elev as usize];
        0
    }

    /// `EN_settankdata`
    #[allow(clippy::too_many_arguments)]
    pub fn settankdata(
        &mut self,
        index: i32,
        elev: f64,
        initlvl: f64,
        minlvl: f64,
        maxlvl: f64,
        diam: f64,
        minvol: f64,
        volcurve: &str,
    ) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        let net = &pr.net;
        if index as usize <= net.njuncs || index <= 0 || index as usize > net.nnodes {
            return 263;
        }
        let j = index as usize - net.njuncs;
        if net.tank[j].a == 0.0 {
            return 263;
        }
        if initlvl < 0.0 || minlvl < 0.0 || maxlvl < 0.0 {
            return 209;
        }
        if minlvl > initlvl || minlvl > maxlvl || initlvl > maxlvl {
            return 225;
        }
        if diam < 0.0 || minvol < 0.0 {
            return 209;
        }
        let ucf = pr.units.ucf;
        let mut curve_index = 0;
        let area = if !volcurve.is_empty() {
            curve_index = (1..net.curve.len())
                .find(|&i| net.curve[i].id == volcurve)
                .unwrap_or(0);
            if curve_index == 0 {
                return 206;
            }
            let c = &net.curve[curve_index];
            let n = c.x.len() - 1;
            if minlvl < c.x[0] || maxlvl > c.x[n] {
                return 225;
            }
            (c.y[n] - c.y[0]) / (c.x[n] - c.x[0])
        } else {
            PI * diam * diam / 4.0
        };
        let elev_ = ucf[Field::Elev as usize];
        let node = net.tank[j].node;
        pr.net.node[node].el = elev / elev_;
        let t = &mut pr.net.tank[j];
        t.a = area / elev_ / elev_;
        t.h0 = (elev + initlvl) / elev_;
        t.hmin = (elev + minlvl) / elev_;
        t.hmax = (elev + maxlvl) / elev_;
        t.vcurve = curve_index;
        if curve_index == 0 {
            t.vmin = if minvol > 0.0 {
                minvol / ucf[Field::Volume as usize]
            } else {
                t.a * (t.hmin - elev / elev_)
            };
        } else {
            let hmin = t.hmin;
            pr.net.tank[j].vmin = hydraul::tankvolume(pr, j, hmin);
        }
        let (h0, hmax) = (pr.net.tank[j].h0, pr.net.tank[j].hmax);
        pr.net.tank[j].v0 = hydraul::tankvolume(pr, j, h0);
        pr.net.tank[j].vmax = hydraul::tankvolume(pr, j, hmax);
        0
    }

    /// `EN_setcoord`
    pub fn setcoord(&mut self, index: i32, x: f64, y: f64) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if index < 1 || index as usize > o.pr.net.nnodes {
            return 203;
        }
        o.meta.node_xy[index as usize] = Some((x, y));
        0
    }

    // ---- Demands ---------------------------------------------------------------------

    /// `EN_setdemandmodel`
    pub fn setdemandmodel(&mut self, model: i32, pmin: f64, preq: f64, pexp: f64) -> i32 {
        if !(0..=1).contains(&model) {
            return 251;
        }
        if model == 1 && (pexp <= 0.0 || pmin < 0.0 || preq - pmin < MINPDIFF) {
            return 208;
        }
        // EPANET writes into the (zeroed) project even when none is open.
        let Some(o) = self.om() else { return 0 };
        let pr = &mut o.pr;
        let ucf = pr.units.ucf[Field::Pressure as usize];
        pr.hyd.demand_model = if model == 1 {
            DemandModel::Pda
        } else {
            DemandModel::Dda
        };
        pr.hyd.pmin = pmin / ucf;
        pr.hyd.preq = preq / ucf;
        pr.hyd.pexp = pexp;
        0
    }

    /// `EN_adddemand`
    pub fn adddemand(&mut self, node_index: i32, base: f64, pattern: &str, name: &str) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if node_index <= 0 || node_index as usize > o.pr.net.nnodes {
            return 203;
        }
        let mut pat = 0;
        if !pattern.is_empty() && self.getpatternindex(pattern, &mut pat) > 0 {
            return 205;
        }
        let Some(o) = self.om() else { return 102 };
        let i = node_index as usize;
        if i > o.pr.net.njuncs {
            return 0;
        }
        let base = base / o.pr.units.ucf[Field::Flow as usize];
        o.pr.net.node[i].d.push(Demand {
            base,
            pat: pat as usize,
        });
        o.meta.demand_name[i].push(xstrcpy(name, MAXID));
        0
    }

    /// `EN_deletedemand`
    pub fn deletedemand(&mut self, node_index: i32, demand_index: i32) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if node_index <= 0 || node_index as usize > o.pr.net.nnodes {
            return 203;
        }
        let i = node_index as usize;
        if i <= o.pr.net.njuncs {
            let d = &mut o.pr.net.node[i].d;
            if d.is_empty() {
                return 253;
            }
            // EPANET's list walk: an index below 1 removes the first category's successor.
            let k = if demand_index == 1 {
                0
            } else {
                let k = demand_index.max(1) as usize - 1;
                if k >= d.len() {
                    return 253;
                }
                k
            };
            d.remove(k);
            o.meta.demand_name[i].remove(k);
        }
        0
    }

    fn demand_slot(
        o: &mut Open,
        node_index: i32,
        demand_index: i32,
        nmax: usize,
    ) -> Result<usize, i32> {
        if node_index <= 0 || node_index as usize > nmax {
            return Err(203);
        }
        let d = &o.pr.net.node[node_index as usize].d;
        if demand_index < 1 || demand_index as usize > d.len() {
            return Err(253);
        }
        Ok(demand_index as usize - 1)
    }

    /// `EN_setbasedemand`
    pub fn setbasedemand(&mut self, node_index: i32, demand_index: i32, base: f64) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let nn = o.pr.net.nnodes;
        match Self::demand_slot(o, node_index, demand_index, nn) {
            Ok(k) => {
                let q = base / o.pr.units.ucf[Field::Flow as usize];
                o.pr.net.node[node_index as usize].d[k].base = q;
                0
            }
            Err(e) => e,
        }
    }

    /// `EN_setdemandname`
    pub fn setdemandname(&mut self, node_index: i32, demand_index: i32, name: &str) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let nj = o.pr.net.njuncs;
        match Self::demand_slot(o, node_index, demand_index, nj) {
            Ok(k) => {
                o.meta.demand_name[node_index as usize][k] = xstrcpy(name, MAXID);
                0
            }
            Err(e) => e,
        }
    }

    /// `EN_setdemandpattern`
    pub fn setdemandpattern(&mut self, node_index: i32, demand_index: i32, pat_index: i32) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let nn = o.pr.net.nnodes;
        if node_index <= 0 || node_index as usize > nn {
            return 203;
        }
        if pat_index < 0 || pat_index as usize >= o.pr.net.pattern.len() {
            return 205;
        }
        match Self::demand_slot(o, node_index, demand_index, nn) {
            Ok(k) => {
                o.pr.net.node[node_index as usize].d[k].pat = pat_index as usize;
                0
            }
            Err(e) => e,
        }
    }

    // ---- Links -----------------------------------------------------------------------

    /// `EN_setlinkid`
    pub fn setlinkid(&mut self, index: i32, new_id: &str) -> i32 {
        let Some(o) = self.om() else { return 204 };
        if index <= 0 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        if !namevalid(new_id) {
            return 252;
        }
        if Self::findlink(o, new_id) > 0 {
            return 215;
        }
        o.pr.net.link[index as usize].id = new_id.to_string();
        0
    }

    /// `EN_setlinkvalue`
    pub fn setlinkvalue(&mut self, index: i32, property: i32, value: f64) -> i32 {
        // A pipe's setting is its roughness.
        if (property == EN_INITSETTING || property == EN_SETTING)
            && let Some(o) = self.o()
            && index > 0
            && (index as usize) <= o.pr.net.nlinks
            && o.pr.net.link[index as usize].link_type <= LinkType::Pipe
        {
            let _ = self.setlinkvalue(index, EN_ROUGHNESS, value);
            if property == EN_INITSETTING
                && let Some(o) = self.om()
            {
                let kc = o.pr.net.link[index as usize].kc;
                o.pr.net.link[index as usize].init_setting = kc;
            }
            return 0;
        }
        let Some(o) = self.om() else { return 102 };
        let open_h = o.open_h;
        let open_q = o.open_q;
        let pr = &mut o.pr;
        if index <= 0 || index as usize > pr.net.nlinks {
            return 204;
        }
        let i = index as usize;
        let ucf = pr.units.ucf;
        let u = |f: Field| ucf[f as usize];
        let npats = pr.net.pattern.len() - 1;
        let ncurves = pr.net.curve.len() - 1;
        let lt = pr.net.link[i].link_type;
        let mut value = value;
        match property {
            EN_DIAMETER => {
                if lt != LinkType::Pump {
                    if value <= 0.0 {
                        return 211;
                    }
                    value /= u(Field::Diam);
                    let link = &mut pr.net.link[i];
                    let r = link.diam / value;
                    link.km *= r * r * (r * r);
                    link.diam = value;
                    resistcoeff(pr, i);
                }
            }
            EN_LENGTH => {
                if lt <= LinkType::Pipe {
                    if value <= 0.0 {
                        return 211;
                    }
                    pr.net.link[i].len = value / u(Field::Elev);
                    resistcoeff(pr, i);
                }
            }
            EN_ROUGHNESS => {
                if lt <= LinkType::Pipe {
                    if value <= 0.0 {
                        return 211;
                    }
                    let link = &mut pr.net.link[i];
                    link.kc = value;
                    if pr.hyd.formflag == Formula::Dw {
                        link.kc /= 1000.0 * u(Field::Elev);
                    }
                    if open_h {
                        resistcoeff(pr, i);
                    } else {
                        let kc = pr.net.link[i].kc;
                        pr.net.link[i].init_setting = kc;
                    }
                }
            }
            EN_MINORLOSS => {
                if lt != LinkType::Pump {
                    if value < 0.0 {
                        return 211;
                    }
                    let link = &mut pr.net.link[i];
                    link.km = 0.02517 * value / (link.diam * link.diam) / (link.diam * link.diam);
                }
            }
            EN_INITSTATUS | EN_STATUS => {
                if lt == LinkType::CvPipe {
                    return 207;
                }
                let s = iround(value);
                if !(0..=1).contains(&s) {
                    return 211;
                }
                if property == EN_INITSTATUS {
                    pr.net.link[i].init_status = if s == 1 { Status::Open } else { Status::Closed };
                } else {
                    hydraul::setlinkstatus(pr, i, s == 1);
                }
            }
            EN_INITSETTING | EN_SETTING => {
                match lt {
                    LinkType::Pump => {
                        if value < 0.0 {
                            return 211;
                        }
                    }
                    LinkType::Prv | LinkType::Psv | LinkType::Pbv => value /= u(Field::Pressure),
                    LinkType::Fcv => value /= u(Field::Flow),
                    LinkType::Tcv | LinkType::Pcv => {}
                    LinkType::Gpv => return 207,
                    _ => return 0,
                }
                if property == EN_INITSETTING {
                    let link = &mut pr.net.link[i];
                    link.kc = value;
                    link.init_setting = value;
                    if link.link_type > LinkType::Pump && link.link_type != LinkType::Gpv {
                        link.init_status = Status::Active;
                    }
                } else {
                    hydraul::setlinksetting(pr, i, value);
                }
            }
            EN_KBULK => {
                if lt <= LinkType::Pipe {
                    pr.net.link[i].kb = value / SECPERDAY_F;
                    pr.qual.reactflag = true;
                }
            }
            EN_KWALL => {
                if lt <= LinkType::Pipe {
                    pr.net.link[i].kw = value / SECPERDAY_F;
                    pr.qual.reactflag = true;
                }
            }
            EN_LINKPATTERN => {
                if lt == LinkType::Pump {
                    let p = iround(value);
                    if p < 0 || p as usize > npats {
                        return 205;
                    }
                    let k = pr.net.findpump(i);
                    pr.net.pump[k].upat = p as usize;
                }
            }
            EN_PUMP_POWER => {
                if lt == LinkType::Pump {
                    if value <= 0.0 {
                        return 211;
                    }
                    let k = pr.net.findpump(i);
                    pr.net.pump[k].ptype = PumpType::ConstHp;
                    pr.net.pump[k].hcurve = 0;
                    pr.net.link[i].km = value;
                }
            }
            EN_PUMP_HCURVE => {
                if lt == LinkType::Pump {
                    return self.setheadcurveindex(index, iround(value));
                }
            }
            EN_PUMP_ECURVE => {
                if lt == LinkType::Pump {
                    let c = iround(value);
                    if c < 0 || c as usize > ncurves {
                        return 205;
                    }
                    let k = pr.net.findpump(i);
                    pr.net.pump[k].ecurve = c as usize;
                }
            }
            EN_PUMP_ECOST => {
                if lt == LinkType::Pump {
                    if value < 0.0 {
                        return 211;
                    }
                    let k = pr.net.findpump(i);
                    pr.net.pump[k].ecost = value;
                }
            }
            EN_PUMP_EPAT => {
                if lt == LinkType::Pump {
                    let p = iround(value);
                    if p < 0 || p as usize > npats {
                        return 205;
                    }
                    let k = pr.net.findpump(i);
                    pr.net.pump[k].epat = p as usize;
                }
            }
            EN_PCV_CURVE => {
                if lt == LinkType::Pcv {
                    let c = iround(value);
                    if c < 0 || c as usize > ncurves {
                        return 206;
                    }
                    let k = pr.net.findvalve(i);
                    pr.net.valve[k].curve = c as usize;
                }
            }
            EN_GPV_CURVE => {
                if lt == LinkType::Gpv {
                    let c = iround(value);
                    if c < 0 || c as usize > ncurves {
                        return 206;
                    }
                    pr.net.link[i].kc = f64::from(c);
                    if !open_h {
                        pr.net.link[i].init_setting = f64::from(c);
                    }
                }
            }
            EN_LEAK_AREA => {
                if value < 0.0 {
                    return 211;
                }
                pr.net.link[i].leak_area = value * u(Field::Length);
            }
            EN_LEAK_EXPAN => {
                if value < 0.0 {
                    return 211;
                }
                pr.net.link[i].leak_expan = value * u(Field::Length);
            }
            EN_VALVE_TYPE => {
                if open_h || open_q {
                    return 262;
                }
                if lt <= LinkType::Pump {
                    return 264;
                }
                let v = iround(value);
                let Some(t) = link_type(v).filter(|t| *t >= LinkType::Prv) else {
                    return 213;
                };
                if t == lt {
                    return 0;
                }
                return changevalvetype(pr, i, t);
            }
            _ => return 251,
        }
        0
    }

    /// `EN_setpipedata`
    pub fn setpipedata(
        &mut self,
        index: i32,
        length: f64,
        diam: f64,
        rough: f64,
        mloss: f64,
    ) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let open_h = o.open_h;
        let pr = &mut o.pr;
        if index <= 0 || index as usize > pr.net.nlinks {
            return 204;
        }
        let i = index as usize;
        if pr.net.link[i].link_type > LinkType::Pipe {
            return 0;
        }
        if length <= 0.0 || diam <= 0.0 || rough <= 0.0 || mloss < 0.0 {
            return 211;
        }
        let ucf = pr.units.ucf;
        let dw = pr.hyd.formflag == Formula::Dw;
        let link = &mut pr.net.link[i];
        link.len = length / ucf[Field::Elev as usize];
        link.diam = diam / ucf[Field::Diam as usize];
        link.kc = rough;
        if dw {
            link.kc /= 1000.0 * ucf[Field::Elev as usize];
        }
        link.km = 0.02517 * mloss / (link.diam * link.diam) / (link.diam * link.diam);
        if open_h {
            resistcoeff(pr, i);
        } else {
            pr.net.link[i].init_setting = pr.net.link[i].kc;
        }
        0
    }

    /// `EN_setvertex`
    pub fn setvertex(&mut self, index: i32, vertex: i32, x: f64, y: f64) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        let v = &mut o.meta.link_vertices[index as usize];
        if vertex <= 0 || vertex as usize > v.len() {
            return 255;
        }
        v[vertex as usize - 1] = (x, y);
        0
    }

    /// `EN_setvertices`
    pub fn setvertices(&mut self, index: i32, x: &[f64], y: &[f64]) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        o.meta.link_vertices[index as usize] = x.iter().copied().zip(y.iter().copied()).collect();
        0
    }

    /// `EN_setheadcurveindex`
    pub fn setheadcurveindex(&mut self, link_index: i32, curve_index: i32) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let net = &mut o.pr.net;
        if link_index < 1 || link_index as usize > net.nlinks {
            return 204;
        }
        let k = link_index as usize;
        if net.link[k].link_type != LinkType::Pump {
            return 0;
        }
        if curve_index < 0 || curve_index as usize >= net.curve.len() {
            return 206;
        }
        let p = net.findpump(k);
        net.pump[p].hcurve = curve_index as usize;
        net.link[k].km = 0.0;
        0
    }

    // ---- Time patterns ---------------------------------------------------------------

    /// `EN_addpattern`
    pub fn addpattern(&mut self, id: &str) -> i32 {
        if !self.is_open() {
            return 102;
        }
        if self.getpatternindex(id, &mut 0) == 0 {
            return 215;
        }
        if !namevalid(id) {
            return 252;
        }
        let Some(o) = self.om() else { return 102 };
        o.pr.net.pattern.push(Pattern {
            id: id.to_string(),
            f: vec![1.0],
        });
        o.meta.pattern_comment.push(None);
        0
    }

    /// `EN_deletepattern`
    pub fn deletepattern(&mut self, index: i32) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if o.open_h || o.open_q {
            return 262;
        }
        let pr = &mut o.pr;
        if index < 1 || index as usize >= pr.net.pattern.len() {
            return 205;
        }
        let i = index as usize;
        adjustpatterns(&mut pr.net, i);
        adjustpattern(&mut pr.hyd.epat, i);
        adjustpattern(&mut pr.hyd.def_pat, i);
        pr.net.pattern.remove(i);
        o.meta.pattern_comment.remove(i);
        0
    }

    /// `EN_setpatternid`
    pub fn setpatternid(&mut self, index: i32, id: &str) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let net = &mut o.pr.net;
        if index < 1 || index as usize >= net.pattern.len() {
            return 205;
        }
        if !namevalid(id) {
            return 252;
        }
        if (1..net.pattern.len()).any(|i| i != index as usize && net.pattern[i].id == id) {
            return 215;
        }
        net.pattern[index as usize].id = id.to_string();
        0
    }

    /// `EN_setpatternvalue`
    pub fn setpatternvalue(&mut self, index: i32, period: i32, value: f64) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let net = &mut o.pr.net;
        if index <= 0 || index as usize >= net.pattern.len() {
            return 205;
        }
        let f = &mut net.pattern[index as usize].f;
        if period <= 0 || period as usize > f.len() {
            return 251;
        }
        f[period as usize - 1] = value;
        0
    }

    /// `EN_setpattern`
    pub fn setpattern(&mut self, index: i32, values: &[f64]) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let net = &mut o.pr.net;
        if index <= 0 || index as usize >= net.pattern.len() {
            return 205;
        }
        if values.is_empty() {
            return 202;
        }
        net.pattern[index as usize].f = values.to_vec();
        0
    }

    /// `EN_loadpatternfile`: multipliers from the first number on each line of a file.
    pub fn loadpatternfile(&mut self, filename: &str, id: &str) -> i32 {
        if !self.is_open() {
            return 102;
        }
        let Ok(text) = std::fs::read(filename) else {
            return 302;
        };
        let mut i = 0;
        let err = self.getpatternindex(id, &mut i);
        if err == 205 {
            let err = self.addpattern(id);
            if err != 0 {
                return err;
            }
            i = self.o().map_or(0, |o| o.pr.net.pattern.len() as i32 - 1);
        }
        let values: Vec<f64> = String::from_utf8_lossy(&text)
            .lines()
            .filter_map(|line| {
                let tok = line.split([' ', '\t', '\r']).find(|t| !t.is_empty())?;
                tok.parse::<f64>().ok().filter(|v| v.is_finite())
            })
            .collect();
        if values.is_empty() {
            // EN_setpattern with no values.
            return 202;
        }
        self.setpattern(i, &values)
    }

    // ---- Data curves -----------------------------------------------------------------

    /// `EN_addcurve`
    pub fn addcurve(&mut self, id: &str) -> i32 {
        if !self.is_open() {
            return 102;
        }
        if self.getcurveindex(id, &mut 0) == 0 {
            return 215;
        }
        if !namevalid(id) {
            return 252;
        }
        let Some(o) = self.om() else { return 102 };
        o.pr.net.curve.push(Curve {
            id: id.to_string(),
            x: vec![1.0],
            y: vec![1.0],
        });
        o.curve_type.push(EN_GENERIC_CURVE);
        o.meta.curve_comment.push(None);
        0
    }

    /// `EN_deletecurve`
    pub fn deletecurve(&mut self, index: i32) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if o.open_h || o.open_q {
            return 262;
        }
        let net = &mut o.pr.net;
        if index < 1 || index as usize >= net.curve.len() {
            return 205;
        }
        let i = index as usize;
        adjustcurves(net, i);
        net.curve.remove(i);
        o.curve_type.remove(i);
        o.meta.curve_comment.remove(i);
        0
    }

    /// `EN_setcurveid`
    pub fn setcurveid(&mut self, index: i32, id: &str) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let net = &mut o.pr.net;
        if index < 1 || index as usize >= net.curve.len() {
            return 205;
        }
        if !namevalid(id) {
            return 252;
        }
        if (1..net.curve.len()).any(|i| i != index as usize && net.curve[i].id == id) {
            return 215;
        }
        net.curve[index as usize].id = id.to_string();
        0
    }

    /// `EN_setcurvetype`
    pub fn setcurvetype(&mut self, index: i32, curve_type: i32) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if index < 1 || index as usize >= o.pr.net.curve.len() {
            return 206;
        }
        if !(0..=EN_VALVE_CURVE).contains(&curve_type) {
            return 251;
        }
        o.curve_type[index as usize] = curve_type;
        0
    }

    /// `EN_setcurvevalue`
    pub fn setcurvevalue(&mut self, curve_index: i32, point_index: i32, x: f64, y: f64) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let net = &mut o.pr.net;
        if curve_index <= 0 || curve_index as usize >= net.curve.len() {
            return 206;
        }
        let c = &mut net.curve[curve_index as usize];
        if point_index <= 0 {
            return 251;
        }
        let npts = c.x.len();
        let mut n = point_index as usize - 1;
        let x1 = if n >= 1 {
            c.x.get(n - 1).copied().unwrap_or(0.0)
        } else {
            -1.0e37
        };
        let x2 = if n + 1 < npts { c.x[n + 1] } else { 1.0e37 };
        if x <= x1 || x >= x2 {
            return 230;
        }
        if point_index as usize > npts {
            c.x.push(0.0);
            c.y.push(0.0);
            n = c.x.len() - 1;
        }
        c.x[n] = x;
        c.y[n] = y;
        0
    }

    /// `EN_setcurve`
    pub fn setcurve(&mut self, index: i32, x: &[f64], y: &[f64]) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let net = &mut o.pr.net;
        if index <= 0 || index as usize >= net.curve.len() {
            return 206;
        }
        if x.is_empty() || y.len() < x.len() {
            return 202;
        }
        if x.windows(2).any(|w| w[0] >= w[1]) {
            return 230;
        }
        let c = &mut net.curve[index as usize];
        c.x = x.to_vec();
        c.y = y[..x.len()].to_vec();
        0
    }

    // ---- Simple controls -------------------------------------------------------------

    /// `EN_addcontrol`
    pub fn addcontrol(
        &mut self,
        control_type: i32,
        link_index: i32,
        setting: f64,
        node_index: i32,
        level: f64,
        index: &mut i32,
    ) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if link_index <= 0 || link_index as usize > o.pr.net.nlinks {
            return 204;
        }
        let c = match makecontrol(
            &o.pr,
            control_type,
            link_index as usize,
            setting,
            node_index,
            level,
        ) {
            Ok(c) => c,
            Err(e) => return e,
        };
        let net = &mut o.pr.net;
        net.control.truncate(net.ncontrols + 1);
        net.control.push(c);
        net.ncontrols += 1;
        *index = net.ncontrols as i32;
        0
    }

    /// `EN_deletecontrol`
    pub fn deletecontrol(&mut self, index: i32) -> i32 {
        let Some(o) = self.om() else { return 241 };
        let net = &mut o.pr.net;
        if index <= 0 || index as usize > net.ncontrols {
            return 241;
        }
        net.control.remove(index as usize);
        net.ncontrols -= 1;
        0
    }

    /// `EN_setcontrol`
    pub fn setcontrol(
        &mut self,
        index: i32,
        control_type: i32,
        link_index: i32,
        setting: f64,
        node_index: i32,
        level: f64,
    ) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.ncontrols {
            return 241;
        }
        if link_index == 0 {
            o.pr.net.control[index as usize].link = 0;
            return 0;
        }
        if link_index < 0 || link_index as usize > o.pr.net.nlinks {
            return 204;
        }
        match makecontrol(
            &o.pr,
            control_type,
            link_index as usize,
            setting,
            node_index,
            level,
        ) {
            Ok(c) => {
                o.pr.net.control[index as usize] = c;
                0
            }
            Err(e) => e,
        }
    }

    /// `EN_setcontrolenabled`
    pub fn setcontrolenabled(&mut self, index: i32, enabled: i32) -> i32 {
        if enabled != 0 && enabled != 1 {
            return 202;
        }
        let Some(o) = self.om() else { return 102 };
        if index <= 0 || index as usize > o.pr.net.ncontrols {
            return 241;
        }
        o.pr.net.control[index as usize].is_enabled = enabled == 1;
        0
    }
}
