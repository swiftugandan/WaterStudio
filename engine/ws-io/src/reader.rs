//! The `.inp` reader. Each `fn section_*` mirrors the function of the same section in
//! OWA-EPANET 2.3.5's `input3.c`; comments note where WaterStudio deliberately differs.

use std::collections::{HashMap, HashSet};

use ws_model::{
    Control, Curve, CurveKind, Demand, Junction, KeywordLine, KeywordSection, Label, Link,
    LinkKind, MixModel, Mixing, Model, Node, NodeKind, OpenClosed, Pattern, Pipe, PipeStatus, Pump,
    PumpCurve, RawSection, Reservoir, Rule, Source, SourceKind, Tank, Valve, ValveSetting,
    ValveType, keyword_matches as kw,
};

use crate::check::{Check, check_inp, input_error_text};
use crate::tokens::{Line, MAX_LINE, tokenize};
use crate::{Issue, ReadResult, Severity};

/// EPANET's limit on ID length (MAXID).
const MAX_ID: usize = 31;
/// EPANET's limit on comment length (MAXMSG).
const MAX_MSG: usize = 255;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sect {
    Title,
    Junctions,
    Reservoirs,
    Tanks,
    Pipes,
    Pumps,
    Valves,
    Controls,
    Rules,
    Demands,
    Sources,
    Emitters,
    Patterns,
    Curves,
    Quality,
    Status,
    Roughness,
    Energy,
    Reactions,
    Mixing,
    Report,
    Times,
    Options,
    Coordinates,
    Vertices,
    Labels,
    Backdrop,
    Tags,
    Leakage,
    End,
}

pub(crate) const SECTIONS: &[(&str, Sect)] = &[
    ("[TITLE]", Sect::Title),
    ("[JUNCTIONS]", Sect::Junctions),
    ("[RESERVOIRS]", Sect::Reservoirs),
    ("[TANKS]", Sect::Tanks),
    ("[PIPES]", Sect::Pipes),
    ("[PUMPS]", Sect::Pumps),
    ("[VALVES]", Sect::Valves),
    ("[CONTROLS]", Sect::Controls),
    ("[RULES]", Sect::Rules),
    ("[DEMANDS]", Sect::Demands),
    ("[SOURCES]", Sect::Sources),
    ("[EMITTERS]", Sect::Emitters),
    ("[PATTERNS]", Sect::Patterns),
    ("[CURVES]", Sect::Curves),
    ("[QUALITY]", Sect::Quality),
    ("[STATUS]", Sect::Status),
    ("[ROUGHNESS]", Sect::Roughness),
    ("[ENERGY]", Sect::Energy),
    ("[REACTIONS]", Sect::Reactions),
    ("[MIXING]", Sect::Mixing),
    ("[REPORT]", Sect::Report),
    ("[TIMES]", Sect::Times),
    ("[OPTIONS]", Sect::Options),
    ("[COORDINATES]", Sect::Coordinates),
    ("[VERTICES]", Sect::Vertices),
    ("[LABELS]", Sect::Labels),
    ("[BACKDROP]", Sect::Backdrop),
    ("[TAGS]", Sect::Tags),
    ("[LEAKAGE]", Sect::Leakage),
    ("[END]", Sect::End),
];

pub(crate) fn find_section(token: &str) -> Option<Sect> {
    SECTIONS
        .iter()
        .find(|(name, _)| kw(token, name))
        .map(|(_, s)| *s)
}

pub(crate) fn section_name(s: Sect) -> &'static str {
    SECTIONS
        .iter()
        .find(|(_, x)| *x == s)
        .map(|(n, _)| *n)
        .unwrap_or("")
}

/// Where the reader is in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    Before,
    In(Sect),
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Formula {
    HazenWilliams,
    DarcyWeisbach,
    ChezyManning,
}

/// Parse `.inp` text into the canonical model.
///
/// Its errors are EPANET's own ([`check_inp`]); its warnings point out what EPANET
/// accepts but the author probably did not mean.
pub fn read_inp(text: &str) -> ReadResult {
    let check = check_inp(text);
    let mut issues: Vec<Issue> = Vec::new();
    if let Some(code) = check.fatal {
        issues.push(Issue {
            line: 0,
            section: String::new(),
            severity: Severity::Error,
            code: Some(code),
            message: format!("Error {code}: {}", input_error_text(code)),
        });
    }
    issues.extend(check.errors.iter().map(|e| Issue {
        line: e.line,
        section: e.section.unwrap_or_default().to_string(),
        severity: Severity::Error,
        code: Some(e.code),
        message: e.message(),
    }));
    let model = read_model(text, &mut issues);
    issues.sort_by_key(|i| i.line);
    ReadResult { model, issues }
}

/// The model a file describes, with the reader's warnings.
fn read_model(text: &str, issues: &mut Vec<Issue>) -> Model {
    let mut r = Reader::new();
    r.prepass(text);
    r.read(text);
    issues.append(&mut r.issues);
    r.model
}

/// What EPANET makes of a file: its verdict, and the network it keeps when errors are
/// allowed (`EN_openX`). With no errors the model is the file's.
pub fn read_as_epanet(text: &str) -> (Check, Model) {
    let check = check_inp(text);
    let model = read_model(&check.repaired(), &mut Vec::new());
    (check, model)
}

struct Reader {
    model: Model,
    issues: Vec<Issue>,
    line_no: usize,
    place: Place,
    formula: Formula,
    /// EPANET's unit system as read so far (SI after an [OPTIONS] UNITS line in SI units).
    si: bool,
    nodes: HashMap<String, usize>,
    links: HashMap<String, usize>,
    patterns: HashMap<String, usize>,
    curves: HashMap<String, usize>,
    /// Number of junctions read so far (EPANET's Njuncs).
    junctions_seen: HashSet<usize>,
    /// Junctions whose first [DEMANDS] line has replaced the junction-line demand.
    demand_replaced: HashSet<usize>,
    /// Comment of the last comment-only line in [PATTERNS] or [CURVES].
    line_comment: Option<String>,
}

/// A number as EPANET's `getfloat` reads it; the model keeps only finite values.
fn parse_f64(s: &str) -> Option<f64> {
    crate::check::getfloat(s).filter(|v| v.is_finite())
}

/// C's `atol`: leading whitespace, optional sign, then digits; 0 if none.
fn atol(s: &str) -> i64 {
    let s = s.trim_start();
    let (sign, digits) = match s.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let n: i64 = digits
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .fold(0i64, |acc, c| {
            acc.saturating_mul(10)
                .saturating_add(i64::from(c.to_digit(10).unwrap_or(0)))
        });
    sign * n
}

/// EPANET's range rule for [STATUS], [QUALITY] and [REACTIONS]: numeric when both ends
/// are positive integers, otherwise by string comparison.
fn in_range(lo: &str, hi: &str, id: &str) -> bool {
    let (i1, i2) = (atol(lo), atol(hi));
    if i1 > 0 && i2 > 0 {
        let i = atol(id);
        i >= i1 && i <= i2
    } else {
        lo <= id && hi >= id
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

impl Reader {
    fn new() -> Self {
        Reader {
            model: Model::default(),
            issues: Vec::new(),
            line_no: 0,
            place: Place::Before,
            formula: Formula::HazenWilliams,
            si: false,
            nodes: HashMap::new(),
            links: HashMap::new(),
            patterns: HashMap::new(),
            curves: HashMap::new(),
            junctions_seen: HashSet::new(),
            demand_replaced: HashSet::new(),
            line_comment: None,
        }
    }

    fn section_label(&self) -> String {
        match self.place {
            Place::In(s) => section_name(s).to_string(),
            Place::Unknown => "[?]".to_string(),
            Place::Before => String::new(),
        }
    }

    fn issue(&mut self, severity: Severity, message: impl Into<String>) {
        self.issues.push(Issue {
            line: self.line_no,
            section: self.section_label(),
            severity,
            code: None,
            message: message.into(),
        });
    }

    fn warn(&mut self, message: impl Into<String>) {
        self.issue(Severity::Warning, message);
    }

    /// EPANET's first pass (`netsize`): register pattern and curve IDs in order of first
    /// appearance, so that elements may refer to patterns and curves defined later.
    fn prepass(&mut self, text: &str) {
        let mut place = Place::Before;
        for raw in text.lines() {
            let Some(tok) = raw.split([' ', '\t', '\r', '\n']).find(|t| !t.is_empty()) else {
                continue;
            };
            if tok.starts_with(';') {
                continue;
            }
            if tok.starts_with('[') {
                place = match find_section(tok) {
                    Some(Sect::End) => break,
                    Some(s) => Place::In(s),
                    None => Place::Unknown,
                };
                continue;
            }
            match place {
                Place::In(Sect::Patterns) if !self.patterns.contains_key(tok) => {
                    self.patterns
                        .insert(tok.to_string(), self.model.patterns.len());
                    self.model.patterns.push(Pattern {
                        id: tok.to_string(),
                        ..Pattern::default()
                    });
                }
                Place::In(Sect::Curves) if !self.curves.contains_key(tok) => {
                    self.curves.insert(tok.to_string(), self.model.curves.len());
                    self.model.curves.push(Curve {
                        id: tok.to_string(),
                        ..Curve::default()
                    });
                }
                _ => {}
            }
        }
    }

    fn read(&mut self, text: &str) {
        for (i, raw) in text.lines().enumerate() {
            self.line_no = i + 1;
            if raw.len() >= MAX_LINE {
                self.warn(format!(
                    "line is longer than EPANET's {MAX_LINE}-character limit; EPANET would split it"
                ));
            }
            let mut line = tokenize(raw);

            if line.tokens.is_empty() {
                match self.place {
                    Place::In(Sect::Patterns | Sect::Curves) => {
                        self.line_comment = line.comment.clone();
                    }
                    Place::In(Sect::Rules) => {
                        if let (Some(rule), Some(_)) = (self.model.rules.last_mut(), &line.comment)
                        {
                            rule.lines.push(raw.trim_end().to_string());
                        }
                    }
                    Place::Unknown => {
                        if let (Some(sec), Some(_)) =
                            (self.model.extra_sections.last_mut(), &line.comment)
                        {
                            sec.lines.push(raw.trim_end().to_string());
                        }
                    }
                    _ => {}
                }
                continue;
            }

            // A data line in [PATTERNS] or [CURVES] takes its description from the
            // comment line just before it, not from its own comment.
            if matches!(self.place, Place::In(Sect::Patterns | Sect::Curves))
                && !line.tokens[0].starts_with('[')
            {
                line.comment = self.line_comment.take();
            }
            self.line_comment = None;

            if line.tokens[0].starts_with('[') {
                match find_section(&line.tokens[0]) {
                    Some(Sect::End) => break,
                    Some(s) => self.place = Place::In(s),
                    None => {
                        self.place = Place::Unknown;
                        self.model.extra_sections.push(RawSection {
                            header: raw.trim().to_string(),
                            lines: Vec::new(),
                        });
                    }
                }
                continue;
            }

            match self.place {
                Place::Before => self.warn("line before the first section is ignored"),
                Place::Unknown => {
                    if let Some(sec) = self.model.extra_sections.last_mut() {
                        sec.lines.push(raw.trim_end().to_string());
                    }
                }
                Place::In(s) => self.dispatch(s, raw, line),
            }
        }
    }

    fn dispatch(&mut self, s: Sect, raw: &str, line: Line) {
        match s {
            Sect::Title => self
                .model
                .title
                .push(raw.trim_end_matches(['\r', '\n']).to_string()),
            Sect::Junctions => self.junction(line),
            Sect::Reservoirs | Sect::Tanks => self.tank(line),
            Sect::Pipes => self.pipe(line),
            Sect::Pumps => self.pump(line),
            Sect::Valves => self.valve(line),
            Sect::Controls => self.model.controls.push(Control {
                tokens: line.tokens,
                comment: line.comment,
            }),
            Sect::Rules => self.rule(raw, &line),
            Sect::Demands => self.demand(line),
            Sect::Sources => self.source(line),
            Sect::Emitters => self.emitter(line),
            Sect::Patterns => self.pattern(line),
            Sect::Curves => self.curve(line),
            Sect::Quality => self.quality(line),
            Sect::Status => self.status(line),
            Sect::Roughness => {} // EPANET ignores [ROUGHNESS] (rows go through newline as a no-op).
            Sect::Energy => self.energy(line),
            Sect::Reactions => self.reaction(line),
            Sect::Mixing => self.mixing(line),
            Sect::Report => push_kw(&mut self.model.report, line),
            Sect::Times => push_kw(&mut self.model.times, line),
            Sect::Options => self.option(line),
            Sect::Coordinates => self.coordinate(line),
            Sect::Vertices => self.vertex(line),
            Sect::Labels => self.label(line),
            Sect::Backdrop => push_kw(&mut self.model.backdrop, line),
            Sect::Tags => self.tag(line),
            Sect::Leakage => self.leakage(line),
            Sect::End => {}
        }
    }

    fn comment(c: Option<String>) -> Option<String> {
        c.map(|c| truncate(&c, MAX_MSG))
    }

    fn add_node(&mut self, id: &str, kind: NodeKind, comment: Option<String>) -> Option<usize> {
        if self.nodes.contains_key(id) {
            return None;
        }
        let idx = self.model.nodes.len();
        self.nodes.insert(id.to_string(), idx);
        self.model.nodes.push(Node {
            id: id.to_string(),
            kind,
            comment: Self::comment(comment),
            tag: None,
            coordinates: None,
            initial_quality: None,
            source: None,
        });
        Some(idx)
    }

    fn pattern_ref(&mut self, tok: &str) -> Option<String> {
        if self.patterns.contains_key(tok) {
            Some(tok.to_string())
        } else {
            None
        }
    }

    fn curve_ref(&mut self, tok: &str) -> Option<String> {
        if self.curves.contains_key(tok) {
            Some(tok.to_string())
        } else {
            None
        }
    }

    fn number(tok: &str) -> Option<f64> {
        parse_f64(tok)
    }

    // [JUNCTIONS] ID Elev [Demand [Pattern]]
    fn junction(&mut self, line: Line) {
        let t = &line.tokens;
        let elevation = match t.get(1) {
            Some(s) => Self::number(s).unwrap_or(0.0),
            None => 0.0,
        };
        let base = match t.get(2) {
            Some(s) => Self::number(s).unwrap_or(0.0),
            None => 0.0,
        };
        let pattern = t.get(3).and_then(|p| self.pattern_ref(p));
        let j = Junction {
            elevation,
            demands: vec![Demand {
                base,
                pattern,
                category: None,
            }],
            emitter: None,
        };
        if let Some(idx) = self.add_node(&t[0], NodeKind::Junction(j), line.comment) {
            self.junctions_seen.insert(idx);
        }
    }

    // [RESERVOIRS] and [TANKS] share EPANET's tankdata(): a node with zero diameter is a reservoir.
    fn tank(&mut self, line: Line) {
        let t = &line.tokens;
        let n = t.len();
        let elevation = t.get(1).and_then(|s| Self::number(s)).unwrap_or(0.0);
        let mut pattern = None;
        let mut tank = Tank {
            elevation,
            ..Tank::default()
        };
        if n <= 3 {
            if n == 3 {
                pattern = self.pattern_ref(&t[2]);
            }
        } else if n >= 6 {
            let nonneg = |i: usize| parse_f64(&t[i]).filter(|v| *v >= 0.0).unwrap_or(0.0);
            tank.init_level = nonneg(2);
            tank.min_level = nonneg(3);
            tank.max_level = nonneg(4);
            tank.diameter = nonneg(5);
            if n >= 7 {
                tank.min_volume = nonneg(6);
            }
            if n >= 8 && !t[7].is_empty() && !t[7].starts_with('*') {
                tank.volume_curve = self.curve_ref(&t[7]);
            }
            if n >= 9 {
                if kw(&t[8], "YES") {
                    tank.overflow = Some(true);
                } else if kw(&t[8], "NO") {
                    tank.overflow = Some(false);
                }
            }
        }
        let kind = if tank.diameter == 0.0 {
            NodeKind::Reservoir(Reservoir {
                head: elevation,
                pattern,
                level: tank.init_level,
            })
        } else {
            NodeKind::Tank(tank)
        };
        self.add_node(&t[0], kind, line.comment);
    }

    fn add_link(
        &mut self,
        id: &str,
        from: &str,
        to: &str,
        kind: LinkKind,
        comment: Option<String>,
    ) -> Option<usize> {
        if from == to {
            return None;
        }
        if self.links.contains_key(id) {
            return None;
        }
        let idx = self.model.links.len();
        self.links.insert(id.to_string(), idx);
        self.model.links.push(Link {
            id: id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            kind,
            comment: Self::comment(comment),
            tag: None,
            vertices: Vec::new(),
        });
        Some(idx)
    }

    // [PIPES] ID Node1 Node2 [Length [Diameter [Roughness [MinorLoss] [Status]]]]
    fn pipe(&mut self, line: Line) {
        let t = &line.tokens;
        let n = t.len();
        if n < 3 {
            self.warn("pipe line with fewer than 3 items is ignored, as EPANET does");
            return;
        }
        // EPANET's defaults depend on the unit system and head loss formula read so far.
        let mut p = Pipe {
            length: if self.si { 100.0 } else { 330.0 },
            diameter: if self.si { 254.0 } else { 10.0 },
            roughness: match self.formula {
                Formula::HazenWilliams => 130.0,
                Formula::DarcyWeisbach => 0.0005,
                Formula::ChezyManning => 0.01,
            },
            minor_loss: 0.0,
            status: PipeStatus::Open,
            leakage: None,
            bulk_coeff: None,
            wall_coeff: None,
        };
        // As in pipedata, the values read before a bad one are kept.
        let positive = |s: &str| parse_f64(s).filter(|v| *v > 0.0);
        let nonneg = |s: &str| parse_f64(s).filter(|v| *v >= 0.0);
        let status_kw = |s: &str| {
            if kw(s, "CV") {
                Some(PipeStatus::CheckValve)
            } else if kw(s, "CLOSED") {
                Some(PipeStatus::Closed)
            } else if kw(s, "OPEN") {
                Some(PipeStatus::Open)
            } else {
                None
            }
        };
        let read = |p: &mut Pipe| -> Option<()> {
            if n > 3 {
                p.length = positive(&t[3])?;
            }
            if n > 4 {
                p.diameter = positive(&t[4])?;
            }
            if n > 5 {
                p.roughness = positive(&t[5])?;
            }
            if n > 6 {
                match status_kw(&t[6]) {
                    Some(s) => p.status = s,
                    None => p.minor_loss = nonneg(&t[6])?,
                }
            }
            if n > 7 {
                p.minor_loss = nonneg(&t[6])?;
                p.status = status_kw(&t[7])?;
            }
            Some(())
        };
        let _ = read(&mut p);
        self.add_link(&t[0], &t[1], &t[2], LinkKind::Pipe(p), line.comment);
    }

    // [PUMPS] ID Node1 Node2 {HEAD curve | POWER p | SPEED s | PATTERN p}...
    fn pump(&mut self, line: Line) {
        let t = &line.tokens;
        let n = t.len();
        if n < 3 {
            self.warn("pump line with fewer than 3 items is ignored, as EPANET does");
            return;
        }
        let mut p = Pump {
            curve: None,
            speed: 1.0,
            pattern: None,
            status: OpenClosed::Open,
            price: None,
            price_pattern: None,
            efficiency_curve: None,
        };
        let mut m = 4;
        while m < n {
            let (key, val) = (&t[m - 1], &t[m]);
            if kw(key, "POWER") {
                match parse_f64(val).filter(|v| *v > 0.0) {
                    Some(v) => p.curve = Some(PumpCurve::Power(v)),
                    None => {
                        break;
                    }
                }
            } else if kw(key, "HEAD") {
                match self.curve_ref(val) {
                    Some(c) => p.curve = Some(PumpCurve::Head(c)),
                    None => break,
                }
            } else if kw(key, "PATT") {
                match self.pattern_ref(val) {
                    Some(pat) => p.pattern = Some(pat),
                    None => break,
                }
            } else if kw(key, "SPEE") {
                match parse_f64(val).filter(|v| *v >= 0.0) {
                    Some(v) => p.speed = v,
                    None => {
                        break;
                    }
                }
            } else {
                break;
            }
            m += 2;
        }
        self.add_link(&t[0], &t[1], &t[2], LinkKind::Pump(p), line.comment);
    }

    // [VALVES] ID Node1 Node2 Diameter Type [Setting [MinorLoss [PCV curve]]]
    fn valve(&mut self, line: Line) {
        let t = &line.tokens;
        let n = t.len();
        if n < 5 {
            self.warn("valve line with fewer than 5 items is ignored, as EPANET does");
            return;
        }
        let types = [
            ("PRV", ValveType::Prv),
            ("PSV", ValveType::Psv),
            ("PBV", ValveType::Pbv),
            ("FCV", ValveType::Fcv),
            ("TCV", ValveType::Tcv),
            ("GPV", ValveType::Gpv),
            ("PCV", ValveType::Pcv),
        ];
        let Some(valve_type) = types.iter().find(|(k, _)| kw(&t[4], k)).map(|(_, v)| *v) else {
            return;
        };
        // EPANET defaults the diameter to 10 (US) or 254 (SI) and the setting and loss to 0.
        let mut v = Valve {
            valve_type,
            diameter: if self.si { 254.0 } else { 10.0 },
            setting: ValveSetting::Value(0.0),
            minor_loss: 0.0,
            pcv_curve: None,
            fixed_status: None,
        };
        if let Some(d) = parse_f64(&t[3]).filter(|d| *d > 0.0) {
            v.diameter = d;
        }
        if n > 5 {
            if valve_type == ValveType::Gpv {
                if let Some(c) = self.curve_ref(&t[5]) {
                    v.setting = ValveSetting::Curve(c);
                }
            } else if let Some(x) = Self::number(&t[5]) {
                v.setting = ValveSetting::Value(x);
            }
        }
        if n > 6
            && let Some(x) = parse_f64(&t[6]).filter(|x| *x >= 0.0)
        {
            v.minor_loss = x;
        }
        if n > 7 && valve_type == ValveType::Pcv {
            v.pcv_curve = self.curve_ref(&t[7]);
        }
        self.add_link(&t[0], &t[1], &t[2], LinkKind::Valve(v), line.comment);
    }

    fn rule(&mut self, raw: &str, line: &Line) {
        let text = raw.trim_end().to_string();
        if kw(&line.tokens[0], "RULE") {
            self.model.rules.push(Rule {
                name: line.tokens.get(1).cloned().unwrap_or_default(),
                lines: vec![text],
            });
        } else if let Some(rule) = self.model.rules.last_mut() {
            rule.lines.push(text);
        }
    }

    fn node_index(&self, id: &str) -> Option<usize> {
        self.nodes.get(id).copied()
    }

    // [DEMANDS] Junction Base [Pattern] [;Category]
    fn demand(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 2 {
            return;
        }
        let Some(base) = Self::number(&t[1]) else {
            return;
        };
        let Some(j) = self.node_index(&t[0]) else {
            return;
        };
        let pattern = match t.get(2) {
            Some(p) => match self.pattern_ref(p) {
                Some(p) => Some(p),
                None => return,
            },
            None => None,
        };
        let category = line.comment.map(|c| truncate(&c, MAX_ID));
        let first = self.demand_replaced.insert(j);
        let NodeKind::Junction(junction) = &mut self.model.nodes[j].kind else {
            return; // EPANET ignores demands on tanks and reservoirs
        };
        match (first, junction.demands.first_mut()) {
            (true, Some(d)) => {
                d.base = base;
                d.pattern = pattern;
                if category.is_some() {
                    d.category = category;
                }
            }
            _ => junction.demands.push(Demand {
                base,
                pattern,
                category,
            }),
        }
    }

    // [SOURCES] Node [Type] Strength [Pattern]
    fn source(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 2 {
            return;
        }
        let Some(j) = self.node_index(&t[0]) else {
            return;
        };
        let kinds = [
            ("CONCEN", SourceKind::Concen),
            ("MASS", SourceKind::Mass),
            ("SETPOINT", SourceKind::Setpoint),
            ("FLOWPACED", SourceKind::FlowPaced),
        ];
        let (kind, i) = match kinds.iter().find(|(k, _)| kw(&t[1], k)) {
            Some((_, k)) => (*k, 2),
            None => (SourceKind::Concen, 1),
        };
        let Some(strength) = t.get(i).and_then(|s| parse_f64(s)) else {
            return;
        };
        let pattern = match t.get(i + 1) {
            Some(p) if !p.is_empty() && p != "*" => match self.pattern_ref(p) {
                Some(p) => Some(p),
                None => return,
            },
            _ => None,
        };
        self.model.nodes[j].source = Some(Source {
            kind,
            strength,
            pattern,
        });
    }

    // [EMITTERS] Junction Coefficient
    fn emitter(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 2 {
            return;
        }
        let Some(j) = self.node_index(&t[0]) else {
            return;
        };
        let Some(k) = Self::number(&t[1]) else {
            return;
        };
        if k < 0.0 {
            return;
        }
        if let NodeKind::Junction(junction) = &mut self.model.nodes[j].kind {
            junction.emitter = Some(k);
        }
    }

    // [LEAKAGE] Pipe AreaCoeff ExpansionCoeff  (EPANET 2.3)
    fn leakage(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 3 {
            return;
        }
        let Some(&l) = self.links.get(&t[0]) else {
            return;
        };
        let (Some(c1), Some(c2)) = (Self::number(&t[1]), Self::number(&t[2])) else {
            return;
        };
        if c1 < 0.0 || c2 < 0.0 {
            return;
        }
        if let LinkKind::Pipe(p) = &mut self.model.links[l].kind {
            p.leakage = Some((c1, c2));
        }
    }

    fn pattern(&mut self, line: Line) {
        let t = &line.tokens;
        let Some(&i) = self.patterns.get(&t[0]) else {
            return;
        };
        if t.len() < 2 {
            return;
        }
        let pat = &mut self.model.patterns[i];
        if pat.comment.is_none() {
            pat.comment = Self::comment(line.comment);
        }
        for s in &t[1..] {
            // EPANET has already extended the pattern with 1.0 for every token on the line.
            let v = parse_f64(s).unwrap_or(1.0);
            self.model.patterns[i].multipliers.push(v);
        }
    }

    fn curve(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 3 {
            return;
        }
        let (Some(x), Some(y)) = (Self::number(&t[1]), Self::number(&t[2])) else {
            return;
        };
        let kind = t.get(3).and_then(|k| {
            [
                ("VOLUME", CurveKind::Volume),
                ("PUMP", CurveKind::Pump),
                ("EFFIC", CurveKind::Efficiency),
                ("HEADLOSS", CurveKind::Headloss),
                ("GENERIC", CurveKind::Generic),
                ("VALVE", CurveKind::Valve),
            ]
            .iter()
            .find(|(w, _)| kw(k, w))
            .map(|(_, c)| *c)
        });
        let Some(&i) = self.curves.get(&t[0]) else {
            return;
        };
        let c = &mut self.model.curves[i];
        if c.comment.is_none() {
            c.comment = Self::comment(line.comment);
        }
        c.points.push((x, y));
        if kind.is_some() {
            c.kind = kind;
        }
    }

    // [QUALITY] Node Value  |  FromNode ToNode Value
    fn quality(&mut self, line: Line) {
        let t = &line.tokens;
        match t.len() {
            0 | 1 => {}
            2 => {
                let Some(j) = self.node_index(&t[0]) else {
                    return;
                };
                let Some(c) = Self::number(&t[1]) else {
                    return;
                };
                if c < 0.0 {
                    return;
                }
                self.model.nodes[j].initial_quality = Some(c);
            }
            _ => {
                let Some(c) = Self::number(&t[2]) else {
                    return;
                };
                if c < 0.0 {
                    return;
                }
                for node in &mut self.model.nodes {
                    if in_range(&t[0], &t[1], &node.id) {
                        node.initial_quality = Some(c);
                    }
                }
            }
        }
    }

    // [STATUS] Link Status|Setting  |  FromLink ToLink Status|Setting
    fn status(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 2 {
            return;
        }
        let last = &t[t.len() - 1];
        #[derive(Clone, Copy)]
        enum S {
            Open,
            Closed,
            Value(f64),
        }
        let s = if kw(last, "OPEN") {
            S::Open
        } else if kw(last, "CLOSED") {
            S::Closed
        } else {
            match parse_f64(last) {
                Some(v) if v >= 0.0 => S::Value(v),
                Some(_) => {
                    return;
                }
                None => {
                    return;
                }
            }
        };
        let apply = |link: &mut Link| match &mut link.kind {
            LinkKind::Pipe(p) => match s {
                S::Open if p.status != PipeStatus::CheckValve => p.status = PipeStatus::Open,
                S::Closed if p.status != PipeStatus::CheckValve => p.status = PipeStatus::Closed,
                _ => {}
            },
            LinkKind::Pump(p) => match s {
                S::Open => {
                    p.speed = 1.0;
                    p.status = OpenClosed::Open;
                }
                S::Closed => {
                    p.speed = 0.0;
                    p.status = OpenClosed::Closed;
                }
                S::Value(y) => {
                    p.speed = y;
                    p.status = if y == 0.0 {
                        OpenClosed::Closed
                    } else {
                        OpenClosed::Open
                    };
                }
            },
            LinkKind::Valve(v) => match s {
                S::Open => v.fixed_status = Some(OpenClosed::Open),
                S::Closed => v.fixed_status = Some(OpenClosed::Closed),
                S::Value(y) if v.valve_type != ValveType::Gpv => {
                    v.setting = ValveSetting::Value(y);
                    v.fixed_status = None;
                }
                S::Value(_) => {}
            },
        };
        if t.len() == 2 {
            let Some(&l) = self.links.get(&t[0]) else {
                return;
            };
            let link = &mut self.model.links[l];
            let refused = match &link.kind {
                LinkKind::Pipe(p) => p.status == PipeStatus::CheckValve,
                LinkKind::Valve(v) => v.valve_type == ValveType::Gpv && matches!(s, S::Value(_)),
                LinkKind::Pump(_) => false,
            };
            if refused {
                return;
            }
            apply(link);
        } else {
            for link in &mut self.model.links {
                if in_range(&t[0], &t[1], &link.id) {
                    apply(link);
                }
            }
        }
    }

    fn energy(&mut self, line: Line) {
        let t = &line.tokens;
        let n = t.len();
        if n < 3 {
            return;
        }
        if kw(&t[0], "DEMAN") || kw(&t[0], "GLOB") {
            push_kw(&mut self.model.energy, line);
            return;
        }
        if !kw(&t[0], "Pump") {
            return;
        }
        if n < 4 {
            return;
        }
        let Some(&l) = self.links.get(&t[1]) else {
            return;
        };
        let (key, val) = (&t[n - 2], &t[n - 1]);
        let pattern = if kw(key, "PATT") {
            self.pattern_ref(val)
        } else {
            None
        };
        let curve = if kw(key, "EFFI") {
            self.curve_ref(val)
        } else {
            None
        };
        let LinkKind::Pump(p) = &mut self.model.links[l].kind else {
            return;
        };
        if kw(key, "PRICE") {
            if let Some(v) = parse_f64(val).filter(|v| *v >= 0.0) {
                p.price = Some(v);
            }
        } else if kw(key, "PATT") {
            if pattern.is_some() {
                p.price_pattern = pattern;
            }
        } else if kw(key, "EFFI") && curve.is_some() {
            p.efficiency_curve = curve;
        }
    }

    fn reaction(&mut self, line: Line) {
        let t = &line.tokens;
        let n = t.len();
        if n < 3 {
            return; // EPANET ignores short reaction lines
        }
        if kw(&t[0], "ORDER") || kw(&t[0], "ROUG") || kw(&t[0], "LIMIT") || kw(&t[0], "GLOB") {
            push_kw(&mut self.model.reactions, line);
            return;
        }
        let item = if kw(&t[0], "BULK") {
            1
        } else if kw(&t[0], "WALL") {
            2
        } else if kw(&t[0], "Tank") {
            3
        } else {
            return;
        };
        let Some(y) = Self::number(&t[n - 1]) else {
            return;
        };
        if item == 3 {
            let set = |node: &mut Node| {
                if let NodeKind::Tank(tank) = &mut node.kind {
                    tank.bulk_coeff = Some(y);
                }
            };
            if n == 3 {
                if let Some(&j) = self.nodes.get(&t[1]) {
                    set(&mut self.model.nodes[j]);
                }
            } else {
                for node in &mut self.model.nodes {
                    if in_range(&t[1], &t[2], &node.id) {
                        set(node);
                    }
                }
            }
        } else {
            let set = |link: &mut Link| {
                if let LinkKind::Pipe(p) = &mut link.kind {
                    if item == 1 {
                        p.bulk_coeff = Some(y);
                    } else {
                        p.wall_coeff = Some(y);
                    }
                }
            };
            if n == 3 {
                if let Some(&l) = self.links.get(&t[1]) {
                    set(&mut self.model.links[l]);
                }
            } else {
                for link in &mut self.model.links {
                    if in_range(&t[1], &t[2], &link.id) {
                        set(link);
                    }
                }
            }
        }
    }

    // [MIXING] Tank Model [Fraction]
    fn mixing(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 2 {
            return;
        }
        let Some(j) = self.node_index(&t[0]) else {
            return;
        };
        let models = [
            ("MIXED", MixModel::Mixed),
            ("2COMP", MixModel::TwoComp),
            ("FIFO", MixModel::Fifo),
            ("LIFO", MixModel::Lifo),
        ];
        let Some(model) = models.iter().find(|(k, _)| kw(&t[1], k)).map(|(_, m)| *m) else {
            return;
        };
        let mut fraction = 1.0;
        if model == MixModel::TwoComp && t.len() == 3 {
            match parse_f64(&t[2]) {
                Some(v) => fraction = v,
                None => {
                    return;
                }
            }
        }
        if fraction == 0.0 {
            fraction = 1.0;
        }
        if let NodeKind::Tank(tank) = &mut self.model.nodes[j].kind {
            tank.mixing = Some(Mixing { model, fraction });
        }
    }

    fn option(&mut self, line: Line) {
        // getunitsoption: the unit system changes the defaults of the links read after it.
        if let (Some(k), Some(v)) = (line.tokens.first(), line.tokens.get(1))
            && kw(k, "UNIT")
        {
            let words = [
                "CFS", "GPM", "AFD", "MGD", "IMGD", "LPS", "LPM", "CMH", "CMD", "MLD", "CMS", "SI",
            ];
            if let Some(i) = words.iter().position(|w| kw(v, w)) {
                self.si = i >= 5;
            }
        }
        if let (Some(k), Some(v)) = (line.tokens.first(), line.tokens.get(1))
            && kw(k, "HEADL")
        {
            if kw(v, "H-W") {
                self.formula = Formula::HazenWilliams;
            } else if kw(v, "D-W") {
                self.formula = Formula::DarcyWeisbach;
            } else if kw(v, "C-M") {
                self.formula = Formula::ChezyManning;
            }
        }
        push_kw(&mut self.model.options, line);
    }

    fn coordinate(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 3 {
            return;
        }
        let (Some(&j), Some(x), Some(y)) =
            (self.nodes.get(&t[0]), parse_f64(&t[1]), parse_f64(&t[2]))
        else {
            return; // EPANET silently ignores bad coordinate lines
        };
        self.model.nodes[j].coordinates = Some((x, y));
    }

    fn vertex(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 3 {
            return;
        }
        let (Some(&l), Some(x), Some(y)) =
            (self.links.get(&t[0]), parse_f64(&t[1]), parse_f64(&t[2]))
        else {
            return;
        };
        self.model.links[l].vertices.push((x, y));
    }

    // [LABELS] X Y "Text" [AnchorNode]  (used only by the user interface)
    fn label(&mut self, line: Line) {
        let t = &line.tokens;
        match (
            t.first().and_then(|s| parse_f64(s)),
            t.get(1).and_then(|s| parse_f64(s)),
            t.get(2),
        ) {
            (Some(x), Some(y), Some(text)) => self.model.labels.push(Label {
                x,
                y,
                text: text.clone(),
                anchor: t.get(3).cloned(),
            }),
            _ => self.warn("label line needs X, Y and text; ignored"),
        }
    }

    // [TAGS] NODE|LINK ID Tag
    fn tag(&mut self, line: Line) {
        let t = &line.tokens;
        if t.len() < 3 {
            return;
        }
        if kw(&t[0], "NODE") {
            if let Some(&j) = self.nodes.get(&t[1]) {
                self.model.nodes[j].tag = Some(truncate(&t[2], MAX_MSG));
            }
        } else if kw(&t[0], "LINK")
            && let Some(&l) = self.links.get(&t[1])
        {
            self.model.links[l].tag = Some(truncate(&t[2], MAX_MSG));
        }
    }
}

fn push_kw(section: &mut KeywordSection, line: Line) {
    section.lines.push(KeywordLine {
        tokens: line.tokens,
        comment: line.comment,
    });
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn read(text: &str) -> ReadResult {
        read_inp(text)
    }

    #[test]
    fn atol_matches_c() {
        assert_eq!(atol("12abc"), 12);
        assert_eq!(atol("abc"), 0);
        assert_eq!(atol(" -7"), -7);
    }

    #[test]
    fn ranges_are_numeric_when_both_ends_are_numbers() {
        assert!(in_range("10", "20", "15"));
        assert!(!in_range("10", "20", "9"));
        // "9" > "10" as strings, but numerically it is out of range.
        assert!(!in_range("10", "20", "9x"));
        assert!(in_range("A", "C", "B2"));
    }

    #[test]
    fn first_demands_line_replaces_the_junction_demand() {
        let r = read(
            "[JUNCTIONS]\n J1 10 5 \n[DEMANDS]\n J1 7 ;Homes\n J1 3 ;Shops\n[PATTERNS]\n P 1\n",
        );
        let NodeKind::Junction(j) = &r.model.nodes[0].kind else {
            panic!()
        };
        assert_eq!(j.demands.len(), 2);
        assert_eq!(j.demands[0].base, 7.0);
        assert_eq!(j.demands[0].category.as_deref(), Some("Homes"));
        assert_eq!(j.demands[1].category.as_deref(), Some("Shops"));
    }

    #[test]
    fn a_tank_with_zero_diameter_is_a_reservoir() {
        let r = read("[TANKS]\n T1 100 1 0 5 0\n T2 100 1 0 5 20\n");
        assert!(matches!(r.model.nodes[0].kind, NodeKind::Reservoir(_)));
        assert!(matches!(r.model.nodes[1].kind, NodeKind::Tank(_)));
    }

    #[test]
    fn pipe_defaults_follow_the_headloss_formula_read_so_far() {
        let r = read("[JUNCTIONS]\n A 0\n B 0\n[OPTIONS]\n Headloss D-W\n[PIPES]\n P A B\n");
        let LinkKind::Pipe(p) = &r.model.links[0].kind else {
            panic!()
        };
        assert_eq!((p.length, p.diameter, p.roughness), (330.0, 10.0, 0.0005));
    }

    #[test]
    fn pattern_takes_its_description_from_the_comment_line_before_it() {
        let r = read("[PATTERNS]\n;Daily cycle\n P1 1 2 3 ;ignored\n P1 4\n");
        assert_eq!(r.model.patterns[0].comment.as_deref(), Some("Daily cycle"));
        assert_eq!(r.model.patterns[0].multipliers, [1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn status_sets_pump_speed_and_valve_settings() {
        let r = read(
            "[JUNCTIONS]\n A 0\n B 0\n C 0\n[PUMPS]\n P A B POWER 5\n[VALVES]\n V B C 12 PRV 40\n\
             [STATUS]\n P 0\n V CLOSED\n",
        );
        let LinkKind::Pump(p) = &r.model.links[0].kind else {
            panic!()
        };
        assert_eq!((p.speed, p.status), (0.0, OpenClosed::Closed));
        let LinkKind::Valve(v) = &r.model.links[1].kind else {
            panic!()
        };
        assert_eq!(v.fixed_status, Some(OpenClosed::Closed));
        assert_eq!(v.setting, ValveSetting::Value(40.0));
    }

    #[test]
    fn unknown_sections_are_kept_and_reported() {
        let r = read("[GIS]\n layer roads\n[END]\n[JUNCTIONS]\n J 1\n");
        assert_eq!(r.model.extra_sections[0].lines, [" layer roads"]);
        assert!(r.model.nodes.is_empty(), "nothing after [END] is read");
        assert_eq!(r.errors().count(), 1);
    }
}
