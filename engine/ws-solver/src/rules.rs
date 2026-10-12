// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (rules.c and ruletimestep in hydraul.c),
// Copyright (c) 2019 OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.

//! Rule-based controls: parsing `[RULES]`, evaluating premises and taking
//! actions while the hydraulic time step is subdivided (`rules.c`).

use std::collections::HashMap;

use ws_model::keyword_matches as m;

use crate::Project;
use crate::error::SolverError;
use crate::hydraul::{setlinksetting, setlinkstatus, tanklevels};
use crate::input::hour;
use crate::types::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LogOp {
    And,
    Or,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Object {
    Node,
    Link,
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Var {
    Demand,
    Head,
    Grade,
    Level,
    Pressure,
    Flow,
    Status,
    Setting,
    Power,
    Time,
    ClockTime,
    FillTime,
    DrainTime,
}

const VARWORDS: [(&str, Var); 13] = [
    ("DEMAND", Var::Demand),
    ("HEAD", Var::Head),
    ("GRADE", Var::Grade),
    ("LEVEL", Var::Level),
    ("PRESSURE", Var::Pressure),
    ("FLOW", Var::Flow),
    ("STATUS", Var::Status),
    ("SETTING", Var::Setting),
    ("POWER", Var::Power),
    ("TIME", Var::Time),
    ("CLOCKTIME", Var::ClockTime),
    ("FILLTIME", Var::FillTime),
    ("DRAINTIME", Var::DrainTime),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelOp {
    Eq,
    Ne,
    Le,
    Ge,
    Lt,
    Gt,
}

/// Values a status premise or action may name (`Values` in rules.c).
const IS_NUMBER: i32 = 0;
const IS_OPEN: i32 = 1;
const IS_CLOSED: i32 = 2;
const IS_ACTIVE: i32 = 3;

#[derive(Clone, Debug)]
struct Premise {
    logop: LogOp,
    object: Object,
    index: usize,
    variable: Var,
    relop: RelOp,
    status: i32,
    value: f64,
}

#[derive(Clone, Copy, Debug)]
struct Action {
    link: usize,
    status: i32,
    setting: f64,
}

/// One rule-based control.
#[derive(Clone, Debug)]
pub struct Rule {
    pub label: String,
    premises: Vec<Premise>,
    then_actions: Vec<Action>,
    else_actions: Vec<Action>,
    pub priority: f64,
    pub is_enabled: bool,
}

/// `updateruleunits` (rules.c): rescale premise values and action settings when the
/// demand, pressure, head or flow units change.
pub(crate) fn updateruleunits(pr: &mut Project, dcf: f64, pcf: f64, hcf: f64, qcf: f64) {
    let types: Vec<LinkType> = pr.net.link.iter().map(|l| l.link_type).collect();
    let setting_cf = |k: usize| match types.get(k) {
        Some(LinkType::Prv | LinkType::Psv | LinkType::Pbv) => pcf,
        Some(LinkType::Fcv) => qcf,
        _ => 1.0,
    };
    for r in &mut pr.rules {
        for p in &mut r.premises {
            match p.variable {
                Var::Demand => p.value *= dcf,
                Var::Head | Var::Grade | Var::Level => p.value *= hcf,
                Var::Pressure => p.value *= pcf,
                Var::Flow => p.value *= qcf,
                Var::Setting => {
                    if p.object == Object::Link {
                        let f = setting_cf(p.index);
                        if f != 1.0 {
                            p.value *= f;
                        }
                    }
                }
                _ => {}
            }
        }
        for a in r.then_actions.iter_mut().chain(r.else_actions.iter_mut()) {
            if a.setting != MISSING {
                let f = setting_cf(a.link);
                if f != 1.0 {
                    a.setting *= f;
                }
            }
        }
    }
}

/// `adjustrules` (rules.c): delete the rules that name a deleted node or link, then
/// lower the indices above it.
pub(crate) fn adjustrules(rules: &mut Vec<Rule>, node: bool, index: usize) {
    let object = if node { Object::Node } else { Object::Link };
    rules.retain(|r| {
        let named = r
            .premises
            .iter()
            .any(|p| p.object == object && p.index == index)
            || (!node
                && (r.then_actions.iter().any(|a| a.link == index)
                    || r.else_actions.iter().any(|a| a.link == index)));
        !named
    });
    for r in rules.iter_mut() {
        for p in &mut r.premises {
            if p.object == object && p.index > index {
                p.index -= 1;
            }
        }
        if !node {
            for a in r.then_actions.iter_mut().chain(r.else_actions.iter_mut()) {
                if a.link > index {
                    a.link -= 1;
                }
            }
        }
    }
}

impl Rule {
    /// `adjusttankrules` (rules.c) for one rule: move node premises above `njuncs`.
    pub(crate) fn shift_tank_premises(&mut self, njuncs: usize, ndiff: usize) {
        for p in &mut self.premises {
            if p.object == Object::Node && p.index > njuncs {
                p.index += ndiff;
            }
        }
    }

    /// Whether the rule names a node (in a premise) or a link (in a premise or an
    /// action), as `incontrols` (project.c) checks.
    pub fn names(&self, node: bool, index: usize) -> bool {
        let object = if node { Object::Node } else { Object::Link };
        if self
            .premises
            .iter()
            .any(|p| p.object == object && p.index == index)
        {
            return true;
        }
        !node
            && (self.then_actions.iter().any(|a| a.link == index)
                || self.else_actions.iter().any(|a| a.link == index))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Rule,
    If,
    Then,
    Else,
    Priority,
}

fn findmatch<T: Copy>(tok: &str, words: &[(&str, T)]) -> Option<T> {
    words.iter().find(|(w, _)| m(tok, w)).map(|&(_, v)| v)
}

/// `getfloat` (input2.c): the whole token must be a number.
fn getfloat(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn value_word(tok: &str) -> i32 {
    // "XXXX" stands for a number and is never matched by real input.
    findmatch(
        tok,
        &[
            ("XXXX", IS_NUMBER),
            ("OPEN", IS_OPEN),
            ("CLOSED", IS_CLOSED),
            ("ACTIVE", IS_ACTIVE),
        ],
    )
    .unwrap_or(-1)
}

/// `ruledata` over the whole `[RULES]` section. EPANET refuses the project (error 200) on
/// the first malformed rule; the inner code says why.
pub fn parse_rules(
    net: &Network,
    rules: &[ws_model::Rule],
    nodes: &HashMap<&str, usize>,
    links: &HashMap<&str, usize>,
) -> Result<Vec<Rule>, SolverError> {
    let mut out: Vec<Rule> = Vec::new();
    let mut state = State::Priority;
    for line in rules.iter().flat_map(|r| r.lines.iter()) {
        let tok = ws_io::tokenize(line).tokens;
        if tok.is_empty() {
            continue;
        }
        let res = rule_line(net, &tok, nodes, links, &mut out, &mut state);
        if let Err((code, why)) = res {
            let label = out.last().map_or("", |r| r.label.as_str());
            return Err(SolverError::new(
                200,
                format!(
                    "error {code} in rule {label}: {why} (line: {})",
                    line.trim()
                ),
            ));
        }
    }
    Ok(out)
}

type LineResult = Result<(), (i32, String)>;

/// `EN_addrule`: add one rule from its text (lines separated by newlines) to `rules`.
/// Returns EPANET's error code; on an error the last rule is deleted, as EPANET's
/// `deleterule(p, Nrules)` does, even when the failing line added none.
pub(crate) fn addrule(
    net: &Network,
    rules: &mut Vec<Rule>,
    text: &str,
    nodes: &HashMap<&str, usize>,
    links: &HashMap<&str, usize>,
) -> i32 {
    let mut state = State::Priority;
    let mut err = 0;
    for line in text.split('\n') {
        let tok = ws_io::tokenize(line).tokens;
        if tok.is_empty() || tok[0].starts_with(';') {
            continue;
        }
        if let Err((code, _)) = rule_line(net, &tok, nodes, links, rules, &mut state) {
            err = code;
            break;
        }
    }
    if err != 0 {
        rules.pop();
    }
    if err == 201 { 250 } else { err }
}

fn logop_code(l: LogOp) -> i32 {
    match l {
        LogOp::And => 2,
        LogOp::Or => 3,
    }
}

fn object_code(o: Object) -> i32 {
    match o {
        Object::Node => 6,
        Object::Link => 7,
        Object::System => 8,
    }
}

const VARS: [Var; 13] = [
    Var::Demand,
    Var::Head,
    Var::Grade,
    Var::Level,
    Var::Pressure,
    Var::Flow,
    Var::Status,
    Var::Setting,
    Var::Power,
    Var::Time,
    Var::ClockTime,
    Var::FillTime,
    Var::DrainTime,
];
const RELOPS: [RelOp; 6] = [
    RelOp::Eq,
    RelOp::Ne,
    RelOp::Le,
    RelOp::Ge,
    RelOp::Lt,
    RelOp::Gt,
];

impl Rule {
    /// Numbers of premises, THEN actions and ELSE actions.
    pub(crate) fn counts(&self) -> (usize, usize, usize) {
        (
            self.premises.len(),
            self.then_actions.len(),
            self.else_actions.len(),
        )
    }

    /// A premise as `EN_getpremise` reports it: logop, object, index, variable,
    /// relop, status, value.
    pub(crate) fn premise(&self, i: usize) -> Option<(i32, i32, i32, i32, i32, i32, f64)> {
        let p = self.premises.get(i.checked_sub(1)?)?;
        Some((
            logop_code(p.logop),
            object_code(p.object),
            p.index as i32,
            VARS.iter().position(|v| *v == p.variable).unwrap_or(0) as i32,
            RELOPS.iter().position(|r| *r == p.relop).unwrap_or(0) as i32,
            p.status,
            p.value,
        ))
    }

    /// `EN_setpremise`. EPANET stores any codes; these must name what the evaluator
    /// knows (251 otherwise).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn set_premise(
        &mut self,
        i: usize,
        logop: i32,
        object: i32,
        index: i32,
        variable: i32,
        relop: i32,
        status: i32,
        value: f64,
    ) -> i32 {
        let Some(p) = i.checked_sub(1).and_then(|k| self.premises.get_mut(k)) else {
            return 258;
        };
        let logop = match logop {
            2 => LogOp::And,
            3 => LogOp::Or,
            _ => return 251,
        };
        let object = match object {
            6 => Object::Node,
            7 => Object::Link,
            8 => Object::System,
            _ => return 251,
        };
        let (Some(&variable), Some(&relop)) = (
            usize::try_from(variable).ok().and_then(|v| VARS.get(v)),
            usize::try_from(relop).ok().and_then(|r| RELOPS.get(r)),
        ) else {
            return 251;
        };
        *p = Premise {
            logop,
            object,
            index: index.max(0) as usize,
            variable,
            relop,
            status,
            value,
        };
        0
    }

    pub(crate) fn set_premise_index(&mut self, i: usize, index: i32) -> i32 {
        match i.checked_sub(1).and_then(|k| self.premises.get_mut(k)) {
            Some(p) => {
                p.index = index.max(0) as usize;
                0
            }
            None => 258,
        }
    }

    pub(crate) fn set_premise_status(&mut self, i: usize, status: i32) -> i32 {
        match i.checked_sub(1).and_then(|k| self.premises.get_mut(k)) {
            Some(p) => {
                p.status = status;
                0
            }
            None => 258,
        }
    }

    pub(crate) fn set_premise_value(&mut self, i: usize, value: f64) -> i32 {
        match i.checked_sub(1).and_then(|k| self.premises.get_mut(k)) {
            Some(p) => {
                p.value = value;
                0
            }
            None => 258,
        }
    }

    /// A THEN or ELSE action: link, status, setting.
    pub(crate) fn action(&self, then: bool, i: usize) -> Option<(i32, i32, f64)> {
        let list = if then {
            &self.then_actions
        } else {
            &self.else_actions
        };
        let a = list.get(i.checked_sub(1)?)?;
        Some((a.link as i32, a.status, a.setting))
    }

    pub(crate) fn set_action(
        &mut self,
        then: bool,
        i: usize,
        link: i32,
        status: i32,
        setting: f64,
    ) -> i32 {
        let list = if then {
            &mut self.then_actions
        } else {
            &mut self.else_actions
        };
        match i.checked_sub(1).and_then(|k| list.get_mut(k)) {
            Some(a) => {
                *a = Action {
                    link: link.max(0) as usize,
                    status,
                    setting,
                };
                0
            }
            None => 258,
        }
    }
}

fn rule_line(
    net: &Network,
    tok: &[String],
    nodes: &HashMap<&str, usize>,
    links: &HashMap<&str, usize>,
    out: &mut Vec<Rule>,
    state: &mut State,
) -> LineResult {
    #[derive(Clone, Copy)]
    enum Kw {
        Rule,
        If,
        And,
        Or,
        Then,
        Else,
        Priority,
        Disabled,
    }
    let words = [
        ("RULE", Kw::Rule),
        ("IF", Kw::If),
        ("AND", Kw::And),
        ("OR", Kw::Or),
        ("THEN", Kw::Then),
        ("ELSE", Kw::Else),
        ("PRIO", Kw::Priority),
        ("DISABLED", Kw::Disabled),
    ];
    let misplaced = || Err((221, "mis-placed clause".to_string()));
    let Some(key) = findmatch(&tok[0], &words) else {
        return Err((201, "unrecognised keyword".into()));
    };
    match key {
        Kw::Rule => {
            if tok.len() != 2 {
                return Err((201, "missing rule label".into()));
            }
            out.push(Rule {
                label: tok[1].clone(),
                premises: Vec::new(),
                then_actions: Vec::new(),
                else_actions: Vec::new(),
                priority: 0.0,
                is_enabled: true,
            });
            *state = State::Rule;
            Ok(())
        }
        Kw::If => {
            if *state != State::Rule {
                return misplaced();
            }
            *state = State::If;
            newpremise(net, tok, nodes, links, out, LogOp::And)
        }
        Kw::And => match *state {
            State::If => newpremise(net, tok, nodes, links, out, LogOp::And),
            State::Then | State::Else => newaction(net, tok, links, out, *state),
            _ => misplaced(),
        },
        Kw::Or => {
            if *state == State::If {
                newpremise(net, tok, nodes, links, out, LogOp::Or)
            } else {
                misplaced()
            }
        }
        Kw::Then => {
            if *state != State::If {
                return misplaced();
            }
            *state = State::Then;
            newaction(net, tok, links, out, *state)
        }
        Kw::Else => {
            if *state != State::Then {
                return misplaced();
            }
            *state = State::Else;
            newaction(net, tok, links, out, *state)
        }
        Kw::Priority => {
            if *state != State::Then && *state != State::Else {
                return misplaced();
            }
            *state = State::Priority;
            let x = tok
                .get(1)
                .and_then(|t| getfloat(t))
                .ok_or((202, "illegal priority".to_string()))?;
            if let Some(r) = out.last_mut() {
                r.priority = x;
            }
            Ok(())
        }
        Kw::Disabled => {
            if !matches!(*state, State::Then | State::Else | State::Priority) {
                return misplaced();
            }
            if let Some(r) = out.last_mut() {
                r.is_enabled = false;
            }
            Ok(())
        }
    }
}

/// `newpremise`: IF/AND/OR <object> <id> <variable> <operator> <value>, or
/// IF/AND/OR SYSTEM <variable> <operator> <value> [units].
fn newpremise(
    net: &Network,
    tok: &[String],
    nodes: &HashMap<&str, usize>,
    links: &HashMap<&str, usize>,
    out: &mut [Rule],
    logop: LogOp,
) -> LineResult {
    let bad = |what: &str| Err((201, what.to_string()));
    let n = tok.len();
    if n != 5 && n != 6 {
        return bad("wrong number of items in premise");
    }
    let objects = [
        ("Junc", Object::Node),
        ("Reser", Object::Node),
        ("Tank", Object::Node),
        ("Pipe", Object::Link),
        ("Pump", Object::Link),
        ("Valve", Object::Link),
        ("NODE", Object::Node),
        ("LINK", Object::Link),
        ("SYSTEM", Object::System),
    ];
    let object = findmatch(&tok[1], &objects);
    let (object, index, v) = match object {
        Some(Object::System) => {
            let v = findmatch(&tok[2], &VARWORDS);
            match v {
                Some(v @ (Var::Demand | Var::Time | Var::ClockTime)) => (Object::System, 0, v),
                _ => return bad("illegal system variable"),
            }
        }
        Some(obj) => {
            let Some(v) = findmatch(&tok[3], &VARWORDS) else {
                return bad("illegal variable");
            };
            if obj == Object::Node {
                let j = *nodes
                    .get(tok[2].as_str())
                    .ok_or((203, format!("undefined node {}", tok[2])))?;
                match v {
                    Var::Demand | Var::Head | Var::Grade | Var::Level | Var::Pressure => {}
                    Var::FillTime | Var::DrainTime if j > net.njuncs => {}
                    _ => return bad("illegal node variable"),
                }
                (obj, j, v)
            } else {
                let j = *links
                    .get(tok[2].as_str())
                    .ok_or((204, format!("undefined link {}", tok[2])))?;
                match v {
                    Var::Flow | Var::Status | Var::Setting => {}
                    _ => return bad("illegal link variable"),
                }
                (obj, j, v)
            }
        }
        None => return bad("illegal object"),
    };

    // Relational operator; "<=" and ">=" are tried before "<" and ">".
    let ops = [
        ("=", RelOp::Eq),
        ("<>", RelOp::Ne),
        ("<=", RelOp::Le),
        (">=", RelOp::Ge),
        ("<", RelOp::Lt),
        (">", RelOp::Gt),
        ("IS", RelOp::Eq),
        ("NOT", RelOp::Ne),
        ("BELOW", RelOp::Lt),
        ("ABOVE", RelOp::Gt),
    ];
    let mi = if object == Object::System { 3 } else { 4 };
    let Some(relop) = findmatch(&tok[mi], &ops) else {
        return bad("illegal operator");
    };

    let mut status = 0;
    let mut x = MISSING;
    if v == Var::Time || v == Var::ClockTime {
        x = if n == 6 {
            hour(&tok[4], &tok[5])
        } else {
            hour(&tok[4], "")
        } * 3600.0;
        if x < 0.0 {
            return Err((202, "illegal time".into()));
        }
    } else {
        let k = value_word(&tok[n - 1]);
        if k > IS_NUMBER {
            status = k;
        } else {
            x = getfloat(&tok[n - 1]).ok_or((202, format!("illegal value {}", tok[n - 1])))?;
            if v == Var::FillTime || v == Var::DrainTime {
                x *= 3600.0;
            }
        }
    }
    if let Some(r) = out.last_mut() {
        r.premises.push(Premise {
            logop,
            object,
            index,
            variable: v,
            relop,
            status,
            value: x,
        });
    }
    Ok(())
}

/// `newaction`: THEN/ELSE/AND LINK <id> <variable> IS <value>.
fn newaction(
    net: &Network,
    tok: &[String],
    links: &HashMap<&str, usize>,
    out: &mut [Rule],
    state: State,
) -> LineResult {
    if tok.len() != 6 {
        return Err((201, "wrong number of items in action".into()));
    }
    let j = *links
        .get(tok[2].as_str())
        .ok_or((204, format!("undefined link {}", tok[2])))?;
    let lt = net.link[j].link_type;
    if lt == LinkType::CvPipe {
        return Err((207, "attempt to control a check valve".into()));
    }
    let mut s = -1;
    let mut x = MISSING;
    let k = value_word(&tok[5]);
    if k > IS_NUMBER {
        s = k;
    } else {
        x = getfloat(&tok[5])
            .filter(|x| *x >= 0.0)
            .ok_or((202, format!("illegal value {}", tok[5])))?;
    }
    if x != MISSING && lt == LinkType::Gpv {
        return Err((202, "cannot change the setting of a GPV".into()));
    }
    if x != MISSING && lt == LinkType::Pipe {
        s = if x == 0.0 { IS_CLOSED } else { IS_OPEN };
        x = MISSING;
    }
    let a = Action {
        link: j,
        status: s,
        setting: x,
    };
    if let Some(r) = out.last_mut() {
        if state == State::Then {
            r.then_actions.push(a);
        } else {
            r.else_actions.push(a);
        }
    }
    Ok(())
}

/// `ruletimestep` (hydraul.c): subdivide the time step at the rule step, updating
/// tank levels, until a rule fires or the step is used up.
pub fn ruletimestep(pr: &mut Project, tstep: &mut i64) {
    let tnow = pr.times.htime;
    let tmax = tnow + *tstep;
    let (mut dt, mut dt1) = if pr.rules.is_empty() {
        (*tstep, *tstep)
    } else {
        let rs = pr.times.rulestep;
        (rs, rs - tnow % rs)
    };
    dt = dt.min(*tstep);
    dt1 = dt1.min(*tstep);
    if dt1 == 0 {
        dt1 = dt;
    }
    loop {
        pr.times.htime += dt1;
        tanklevels(pr, dt1);
        if checkrules(pr, dt1) > 0 {
            break;
        }
        dt = dt.min(tmax - pr.times.htime);
        dt1 = dt;
        if dt <= 0 {
            break;
        }
    }
    *tstep = pr.times.htime - tnow;
    pr.times.htime = tnow;
}

/// `checkrules`: evaluate every rule and take the winning actions. Returns the number
/// of actions that changed something.
pub fn checkrules(pr: &mut Project, dt: i64) -> usize {
    let time1 = pr.times.htime - dt + 1;
    // The action list grows at its head in EPANET; here the head is the end.
    let mut list: Vec<(Action, usize)> = Vec::new();
    for i in 0..pr.rules.len() {
        if !pr.rules[i].is_enabled {
            continue;
        }
        let actions = if evalpremises(pr, i, time1) {
            pr.rules[i].then_actions.clone()
        } else {
            pr.rules[i].else_actions.clone()
        };
        for a in actions {
            updateactionlist(pr, &mut list, i, a);
        }
    }
    if list.is_empty() {
        0
    } else {
        takeactions(pr, &list)
    }
}

fn updateactionlist(pr: &Project, list: &mut Vec<(Action, usize)>, i: usize, a: Action) {
    // onactionlist: a link already on the list keeps one action, the higher priority.
    for item in list.iter_mut().rev() {
        if item.0.link == a.link {
            if pr.rules[i].priority > pr.rules[item.1].priority {
                *item = (a, i);
            }
            return;
        }
    }
    list.push((a, i));
}

fn evalpremises(pr: &Project, i: usize, time1: i64) -> bool {
    let mut result = true;
    for p in &pr.rules[i].premises {
        if p.logop == LogOp::Or {
            if !result {
                result = checkpremise(pr, p, time1);
            }
        } else {
            if !result {
                return false;
            }
            result = checkpremise(pr, p, time1);
        }
    }
    result
}

fn checkpremise(pr: &Project, p: &Premise, time1: i64) -> bool {
    if p.variable == Var::Time || p.variable == Var::ClockTime {
        checktime(pr, p, time1)
    } else if p.status > IS_NUMBER {
        checkstatus(pr, p)
    } else {
        checkvalue(pr, p)
    }
}

fn checktime(pr: &Project, p: &Premise, time1: i64) -> bool {
    let (t1, t2) = match p.variable {
        Var::Time => (time1, pr.times.htime),
        Var::ClockTime => (
            (time1 + pr.times.tstart) % SECPERDAY,
            (pr.times.htime + pr.times.tstart) % SECPERDAY,
        ),
        _ => return false,
    };
    let x = p.value as i64;
    match p.relop {
        RelOp::Lt => t2 < x,
        RelOp::Le => t2 <= x,
        RelOp::Gt => t2 > x,
        RelOp::Ge => t2 >= x,
        RelOp::Eq | RelOp::Ne => {
            let within = if t2 < t1 {
                x >= t1 || x <= t2
            } else {
                x >= t1 && x <= t2
            };
            if p.relop == RelOp::Eq {
                within
            } else {
                !within
            }
        }
    }
}

fn checkstatus(pr: &Project, p: &Premise) -> bool {
    let s = pr.hyd.link_status[p.index];
    let j = if s <= Status::Closed {
        IS_CLOSED
    } else if s == Status::Active {
        IS_ACTIVE
    } else {
        IS_OPEN
    };
    (j == p.status && p.relop == RelOp::Eq) || (j != p.status && p.relop == RelOp::Ne)
}

fn checkvalue(pr: &Project, p: &Premise) -> bool {
    const TOL: f64 = 1.0e-3;
    let ucf = &pr.units.ucf;
    let i = p.index;
    let hyd = &pr.hyd;
    let net = &pr.net;
    let x = match p.variable {
        Var::Demand => {
            if p.object == Object::System {
                hyd.dsystem * ucf[Field::Demand as usize]
            } else {
                hyd.node_demand[i] * ucf[Field::Demand as usize]
            }
        }
        Var::Head | Var::Grade => hyd.node_head[i] * ucf[Field::Head as usize],
        Var::Pressure => (hyd.node_head[i] - net.node[i].el) * ucf[Field::Pressure as usize],
        Var::Level => (hyd.node_head[i] - net.node[i].el) * ucf[Field::Head as usize],
        Var::Flow => hyd.link_flow[i].abs() * ucf[Field::Flow as usize],
        Var::Setting => {
            if hyd.link_setting[i] == MISSING {
                return false;
            }
            let x = hyd.link_setting[i];
            match net.link[i].link_type {
                LinkType::Prv | LinkType::Psv | LinkType::Pbv => x * ucf[Field::Pressure as usize],
                LinkType::Fcv => x * ucf[Field::Flow as usize],
                _ => x,
            }
        }
        Var::FillTime | Var::DrainTime => {
            if i <= net.njuncs {
                return false;
            }
            let tank = &net.tank[i - net.njuncs];
            if tank.a == 0.0 {
                return false;
            }
            let d = hyd.node_demand[i];
            if p.variable == Var::FillTime {
                if d <= TINY {
                    return false;
                }
                (tank.vmax - tank.v) / d
            } else {
                if d >= -TINY {
                    return false;
                }
                (tank.vmin - tank.v) / d
            }
        }
        _ => return false,
    };
    match p.relop {
        RelOp::Eq => (x - p.value).abs() <= TOL,
        RelOp::Ne => (x - p.value).abs() >= TOL,
        RelOp::Lt => x <= p.value + TOL,
        RelOp::Le => x <= p.value - TOL,
        RelOp::Gt => x >= p.value - TOL,
        RelOp::Ge => x >= p.value + TOL,
    }
}

fn takeactions(pr: &mut Project, list: &[(Action, usize)]) -> usize {
    const TOL: f64 = 1.0e-3;
    let mut n = 0;
    for (a, ri) in list.iter().rev() {
        let k = a.link;
        let s = pr.hyd.link_status[k];
        let v = pr.hyd.link_setting[k];
        let mut x = a.setting;
        let mut flag = false;
        if a.status == IS_OPEN && s <= Status::Closed {
            setlinkstatus(pr, k, true);
            flag = true;
        } else if a.status == IS_CLOSED && s > Status::Closed {
            setlinkstatus(pr, k, false);
            flag = true;
        } else if x != MISSING {
            match pr.net.link[k].link_type {
                LinkType::Prv | LinkType::Psv | LinkType::Pbv => {
                    x /= pr.units.ucf[Field::Pressure as usize]
                }
                LinkType::Fcv => x /= pr.units.ucf[Field::Flow as usize],
                _ => {}
            }
            if (x - v).abs() > TOL {
                setlinksetting(pr, k, x);
                flag = true;
            }
        }
        if flag {
            n += 1;
            if pr.rpt.statflag != crate::report::Statflag::No && crate::report::writing(pr) {
                let label = pr.rules[*ri].label.clone();
                crate::report::writeruleaction(pr, k, &label);
            }
        }
    }
    n
}
