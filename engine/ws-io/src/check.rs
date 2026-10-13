//! EPANET's verdict on an input file.
//!
//! [`check_inp`] reads a file the way OWA-EPANET 2.3.5 does when it opens one: `netsize`
//! sizes the network and registers pattern and curve IDs, then `readdata` (input2.c)
//! passes each line to its section's parser (input3.c, and `ruledata` in rules.c) in file
//! order. It reports the same input errors, with the same codes, offending tokens and
//! report lines, in the same order, including EPANET's quirks (a token cut short by
//! `hour`, the token it blames for a negative leakage expansion, every rule after the
//! first bad one ignored).
//!
//! When errors are allowed (`EN_openX`), EPANET keeps the network it has partly read:
//! some bad lines are skipped, others have already added their element with the values
//! read before the bad one. [`Check::repaired`] is a file with exactly those lines and
//! partial lines, so reading it gives the network EPANET keeps.

use std::collections::HashMap;

use ws_model::keyword_matches as kw;

use crate::reader::{Sect, find_section, section_name};
use crate::tokens::{MAX_LINE, tokenize};

/// EPANET's limit on ID length (MAXID).
const MAX_ID: usize = 31;
/// EPANET's limit on title line length (TITLELEN).
const TITLE_LEN: usize = 79;
/// The smallest difference between PDA's required and minimum pressures (MINPDIFF).
const MIN_PDIFF: f64 = 0.1;

/// An input error, as EPANET reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct InputError {
    /// 1-based line number in the file.
    pub line: usize,
    /// EPANET's error code (200 for a rule, whose own error is in `rule`).
    pub code: u16,
    /// The token EPANET blames (`Tok[ErrTok]`), empty if none.
    pub token: String,
    /// The section heading, e.g. `[PIPES]`; `None` for an unknown section (299).
    pub section: Option<&'static str>,
    /// The line as EPANET read it, with its line ending.
    pub text: String,
    /// For an error in [RULES]: what `ruleerrmsg` reports.
    pub rule: Option<RuleError>,
    /// The report's page size when the error was found (a [REPORT] PAGE line before it
    /// changes where the report breaks pages).
    pub page_size: i32,
    /// The first title line read before the error (it heads a new report page).
    pub title: String,
}

/// A rule-based control's error, as `ruleerrmsg` reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct RuleError {
    /// The rule clause's own error: 201, 202, 203, 204, 207 or 221.
    pub code: u16,
    /// The label of the rule being read, if any rule has been.
    pub label: Option<String>,
    /// The clause's tokens joined by spaces.
    pub clause: String,
}

impl InputError {
    /// The message, e.g. `Error 203: undefined node J9`.
    pub fn message(&self) -> String {
        match &self.rule {
            Some(r) => format!(
                "Error {}: {} in rule {}",
                r.code,
                input_error_text(r.code),
                r.label.as_deref().unwrap_or("?")
            ),
            None if self.token.is_empty() => {
                format!("Error {}: {}", self.code, input_error_text(self.code))
            }
            None => format!(
                "Error {}: {} {}",
                self.code,
                input_error_text(self.code),
                self.token
            ),
        }
    }

    /// The lines EPANET writes to its report for this error (`inperrmsg`, and
    /// `ruleerrmsg` first for a rule). The last one is the input line itself.
    pub fn report_lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(r) = &self.rule {
            let label = match &r.label {
                Some(l) => format!("Rule {l}"),
                None => "[RULES] section".to_string(),
            };
            out.push(format!(
                "Input Error {}: {} in following line of {label}:",
                r.code,
                rule_error_text(r.code)
            ));
            out.push(r.clause.clone());
        }
        let text = input_error_text(self.code);
        out.push(match self.section {
            None => format!(
                "Error {}: {text} {}: section contents ignored.",
                self.code, self.token
            ),
            Some(s) => format!("Error {}: {text} {} in {s} section:", self.code, self.token),
        });
        out.push(self.text.clone());
        out
    }
}

/// The text of an input error (errors.dat), without its number.
pub fn input_error_text(code: u16) -> &'static str {
    match code {
        200 => "one or more errors in input file",
        201 => "syntax error",
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
        252 => "invalid ID name",
        299 => "invalid section keyword",
        _ => "unknown error",
    }
}

/// `R_ERR...` in text.h: a rule clause's error.
fn rule_error_text(code: u16) -> &'static str {
    match code {
        201 => "syntax error",
        202 => "illegal numeric value",
        203 => "undefined node",
        204 => "undefined link",
        207 => "attempt to control a CV",
        _ => "mis-placed clause",
    }
}

/// EPANET's verdict on a file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Check {
    /// Input errors in the order EPANET reports them.
    pub errors: Vec<InputError>,
    /// An error that stops EPANET before it reads any data (`netsize`: a pattern or
    /// curve ID longer than 31 characters). Nothing else is reported then.
    pub fatal: Option<u16>,
    /// [REPORT] MESSAGES as read: whether EPANET reports the final error code.
    pub messages: bool,
    /// The report's page size and first title line once the file is read, for the
    /// report lines that follow the errors.
    pub page_size: i32,
    pub title: String,
    /// The file's lines as EPANET reads them, with the partly read network's fixes.
    lines: Vec<String>,
}

impl Check {
    /// `EN_open`'s code: 0, 200 for input errors, or the fatal error.
    pub fn code(&self) -> u16 {
        match self.fatal {
            Some(c) => c,
            None if !self.errors.is_empty() => 200,
            None => 0,
        }
    }

    /// A file holding the network EPANET keeps after reading this one with errors
    /// allowed: every line it reads cleanly, each partly read line cut to what EPANET
    /// took from it, and nothing of the lines it skips.
    pub fn repaired(&self) -> String {
        self.lines.concat()
    }
}

/// What EPANET does with a bad line when errors are allowed.
#[derive(Clone, Debug, PartialEq)]
enum Fix {
    /// Skipped entirely.
    Drop,
    /// The element was added with the line's first `n` tokens (the rest defaulted).
    Keep(usize),
    /// The element was added as if the line had read these tokens.
    Replace(Vec<String>),
    /// Skipped, but `netsize` already registered the line's first word as a pattern or
    /// curve: keep just that word.
    Prepass,
}

struct Fail {
    code: u16,
    tok: Option<usize>,
    fix: Fix,
}

type R = Result<(), Fail>;

fn fail(code: u16, tok: Option<usize>, fix: Fix) -> Fail {
    Fail { code, tok, fix }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LinkType {
    CvPipe,
    Pipe,
    Pump,
    Prv,
    Psv,
    Pbv,
    Fcv,
    Tcv,
    Gpv,
    Pcv,
}

#[derive(Clone, Copy)]
struct NodeInfo {
    index: usize,
    junction: bool,
}

#[derive(Clone, Copy)]
struct LinkInfo {
    kind: LinkType,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RuleState {
    Rule,
    If,
    Then,
    Else,
    Priority,
    Error,
}

/// C's `getfloat`: `strtod` must consume the whole token. As in C an empty token reads
/// as 0, and `inf`, `nan` and hexadecimal numbers are numbers.
pub fn getfloat(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.is_empty() {
        return Some(0.0);
    }
    let mut i = 0;
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r') {
        i += 1;
    }
    let start = i;
    let negative = b.get(i) == Some(&b'-');
    if matches!(b.get(i), Some(b'+' | b'-')) {
        i += 1;
    }
    let rest = &s[i..];
    let lower = rest.to_ascii_lowercase();
    if lower.starts_with("inf") {
        let len = if lower.starts_with("infinity") { 8 } else { 3 };
        return (len == rest.len()).then_some(if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        });
    }
    if lower.starts_with("nan") {
        let mut end = 3;
        if let Some(close) = rest[3..].strip_prefix('(').and_then(|r| r.find(')')) {
            let inner = &rest[4..4 + close];
            if inner
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            {
                end = 5 + close;
            }
        }
        return (end == rest.len()).then_some(f64::NAN);
    }
    if (lower.starts_with("0x"))
        && lower[2..]
            .bytes()
            .next()
            .is_some_and(|c| c.is_ascii_hexdigit() || c == b'.')
    {
        return hexfloat(&lower[2..]).map(|v| if negative { -v } else { v });
    }
    // Decimal: digits [. digits] [e [sign] digits], at least one digit.
    let d = rest.as_bytes();
    let mut j = 0;
    let mut digits = 0;
    while j < d.len() && d[j].is_ascii_digit() {
        j += 1;
        digits += 1;
    }
    if j < d.len() && d[j] == b'.' {
        j += 1;
        while j < d.len() && d[j].is_ascii_digit() {
            j += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return None;
    }
    if j < d.len() && (d[j] == b'e' || d[j] == b'E') {
        let mut k = j + 1;
        if k < d.len() && (d[k] == b'+' || d[k] == b'-') {
            k += 1;
        }
        if k < d.len() && d[k].is_ascii_digit() {
            while k < d.len() && d[k].is_ascii_digit() {
                k += 1;
            }
            j = k;
        }
    }
    if j != d.len() {
        return None;
    }
    s[start..].parse::<f64>().ok()
}

/// The digits of a hexadecimal float after `0x`, which must all be consumed.
fn hexfloat(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let mut mant: u128 = 0;
    let mut exp: i64 = 0;
    let mut digits = 0;
    let mut j = 0;
    let mut seen_dot = false;
    while j < b.len() {
        let c = b[j];
        if c == b'.' && !seen_dot {
            seen_dot = true;
        } else if let Some(v) = (c as char).to_digit(16) {
            digits += 1;
            if mant < (1u128 << 120) {
                mant = mant * 16 + u128::from(v);
                if seen_dot {
                    exp -= 4;
                }
            } else if !seen_dot {
                exp += 4;
            }
        } else {
            break;
        }
        j += 1;
    }
    if digits == 0 {
        return None;
    }
    if j < b.len() && b[j] == b'p' {
        let mut k = j + 1;
        let mut sign = 1i64;
        if k < b.len() && (b[k] == b'+' || b[k] == b'-') {
            if b[k] == b'-' {
                sign = -1;
            }
            k += 1;
        }
        if k < b.len() && b[k].is_ascii_digit() {
            let mut e: i64 = 0;
            while k < b.len() && b[k].is_ascii_digit() {
                e = e.saturating_mul(10).saturating_add(i64::from(b[k] - b'0'));
                k += 1;
            }
            exp = exp.saturating_add(sign * e);
            j = k;
        }
    }
    if j != b.len() {
        return None;
    }
    #[allow(clippy::cast_precision_loss)]
    let m = mant as f64;
    let e = i32::try_from(exp.clamp(-2000, 2000)).unwrap_or(0);
    Some(m * 2f64.powi(e))
}

/// C's `hour`: a time in hours, or -1. Its `strtok` cuts `time` at the colon after the
/// first field, as C's report of a bad time shows.
fn hour(time: &mut String, units: &str) -> f64 {
    let original = time.clone();
    let fields: Vec<&str> = original.split(':').filter(|f| !f.is_empty()).collect();
    if let Some(first) = fields.first() {
        let lead = original.len() - original.trim_start_matches(':').len();
        let end = lead + first.len();
        if end < original.len() {
            time.truncate(end);
        }
    }
    let mut y = [0.0f64; 4];
    let mut n = 0;
    for f in &fields {
        if n > 3 {
            break;
        }
        match getfloat(f) {
            Some(v) => y[n] = v,
            None => return -1.0,
        }
        n += 1;
    }
    if n == 1 {
        if units.is_empty() {
            return y[0];
        }
        if kw(units, "SEC") {
            return y[0] / 3600.0;
        }
        if kw(units, "MIN") {
            return y[0] / 60.0;
        }
        if kw(units, "HOU") {
            return y[0];
        }
        if kw(units, "DAY") {
            return y[0] * 24.0;
        }
    }
    if n > 1 {
        y[0] = y[0] + y[1] / 60.0 + y[2] / 3600.0;
    }
    if units.is_empty() {
        return y[0];
    }
    if kw(units, "AM") {
        if y[0] >= 13.0 {
            return -1.0;
        }
        return if y[0] >= 12.0 { y[0] - 12.0 } else { y[0] };
    }
    if kw(units, "PM") {
        if y[0] >= 13.0 {
            return -1.0;
        }
        return if y[0] >= 12.0 { y[0] } else { y[0] + 12.0 };
    }
    -1.0
}

/// `findmatch`: the index of the first keyword the token begins with.
fn findmatch(tok: &str, words: &[&str]) -> Option<usize> {
    words.iter().position(|w| !w.is_empty() && kw(tok, w))
}

/// The lines `fgets` reads into a buffer of MAXLINE characters: a longer line arrives
/// in pieces. Each piece with its 1-based line number.
fn fgets_lines(text: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut line = 1;
    for &b in text.as_bytes() {
        cur.push(b);
        if b == b'\n' || cur.len() == MAX_LINE - 1 {
            out.push((String::from_utf8_lossy(&cur).into_owned(), line));
            if b == b'\n' {
                line += 1;
            }
            cur.clear();
        }
    }
    if !cur.is_empty() {
        out.push((String::from_utf8_lossy(&cur).into_owned(), line));
    }
    out
}

/// The first word as `strtok(line, SEPSTR)` finds it.
fn first_word(line: &str) -> Option<&str> {
    line.split([' ', '\t', '\n', '\r']).find(|t| !t.is_empty())
}

/// A line written back from tokens, quoting any that need it.
fn join_tokens(tokens: &[String], comment: Option<&str>) -> String {
    let mut s = tokens
        .iter()
        .map(|t| {
            if t.is_empty() || t.contains([' ', '\t']) || t.starts_with('"') {
                format!("\"{t}\"")
            } else {
                t.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if let Some(c) = comment {
        s.push_str(" ;");
        s.push_str(c);
    }
    s.push('\n');
    s
}

#[derive(Default)]
struct Checker {
    // netsize's counts
    max_juncs: usize,
    max_tanks: usize,
    max_pipes: usize,
    max_pumps: usize,
    max_valves: usize,
    max_controls: usize,
    patterns: HashMap<String, usize>,
    curves: HashMap<String, usize>,
    // readdata's network so far
    nodes: HashMap<String, NodeInfo>,
    links: HashMap<String, LinkInfo>,
    njuncs: usize,
    ntanks: usize,
    npumps: usize,
    nvalves: usize,
    nnodes: usize,
    nlinks: usize,
    ncontrols: usize,
    /// Existing valves for `valvecheck`: (link index, type, start node, end node).
    valves: Vec<(usize, LinkType, usize, usize)>,
    prev_pat: Option<String>,
    prev_curve: Option<String>,
    si: bool,
    pmin: f64,
    preq: f64,
    page_size: i32,
    messages: bool,
    titles: Vec<String>,
    // rules
    rule_state: Option<RuleState>,
    nrules: usize,
    /// For each rule read (1-based), its label and the chunk indices of its lines.
    rules: Vec<(String, Vec<usize>)>,
}

impl Checker {
    fn new() -> Self {
        Checker {
            preq: MIN_PDIFF,
            messages: true,
            rule_state: Some(RuleState::Priority),
            rules: vec![(String::new(), Vec::new())],
            ..Self::default()
        }
    }

    fn max_nodes(&self) -> usize {
        self.max_juncs + self.max_tanks
    }

    fn max_links(&self) -> usize {
        self.max_pipes + self.max_pumps + self.max_valves
    }

    /// `findpattern`: 0 for the default pattern (an empty ID), -1 if none.
    fn findpattern(&self, id: &str) -> i64 {
        if id.is_empty() {
            return 0;
        }
        self.patterns
            .get(id)
            .map_or(-1, |&i| i64::try_from(i).unwrap_or(-1))
    }

    fn findcurve(&self, id: &str) -> bool {
        self.curves.contains_key(id)
    }

    /// `netsize`: count each section's lines and register pattern and curve IDs.
    fn netsize(&mut self, lines: &[(String, usize)]) -> Result<(), u16> {
        let mut sect: Option<Sect> = None;
        for (text, _) in lines {
            let Some(tok) = first_word(text) else {
                continue;
            };
            if tok.starts_with(';') {
                continue;
            }
            if tok.starts_with('[') {
                match find_section(tok) {
                    Some(Sect::End) => break,
                    s => sect = s,
                }
                continue;
            }
            match sect {
                Some(Sect::Junctions) => self.max_juncs += 1,
                Some(Sect::Reservoirs | Sect::Tanks) => self.max_tanks += 1,
                Some(Sect::Pipes) => self.max_pipes += 1,
                Some(Sect::Pumps) => self.max_pumps += 1,
                Some(Sect::Valves) => self.max_valves += 1,
                Some(Sect::Controls) => self.max_controls += 1,
                Some(Sect::Patterns) => register(&mut self.patterns, tok)?,
                Some(Sect::Curves) => register(&mut self.curves, tok)?,
                _ => {}
            }
        }
        Ok(())
    }

    fn add_node(&mut self, id: &str, junction: bool) -> R {
        if self.nodes.contains_key(id) {
            return Err(fail(215, Some(0), Fix::Drop));
        }
        if id.len() > MAX_ID {
            return Err(fail(252, Some(0), Fix::Drop));
        }
        let index = if junction {
            self.njuncs + 1
        } else {
            self.max_juncs + self.ntanks + 1
        };
        self.nodes
            .insert(id.to_string(), NodeInfo { index, junction });
        Ok(())
    }

    fn add_link(&mut self, id: &str, kind: LinkType) -> R {
        if self.links.contains_key(id) {
            return Err(fail(215, Some(0), Fix::Drop));
        }
        if id.len() > MAX_ID {
            return Err(fail(252, Some(0), Fix::Drop));
        }
        self.links.insert(id.to_string(), LinkInfo { kind });
        self.nlinks += 1;
        Ok(())
    }

    fn set_link_kind(&mut self, id: &str, kind: LinkType) {
        if let Some(l) = self.links.get_mut(id) {
            l.kind = kind;
        }
    }

    /// The two end nodes of a link line: 203 for either missing, 222 for the same.
    fn ends(&self, t: &[String]) -> Result<(usize, usize), Fail> {
        let j1 = self.nodes.get(&t[1]).ok_or(fail(203, Some(1), Fix::Drop))?;
        let j2 = self.nodes.get(&t[2]).ok_or(fail(203, Some(2), Fix::Drop))?;
        let (k1, k2) = (node_key(j1), node_key(j2));
        if k1 == k2 {
            return Err(fail(222, Some(0), Fix::Drop));
        }
        Ok((k1, k2))
    }

    fn is_tank_key(&self, key: usize) -> bool {
        key >= TANK_KEY
    }

    // ---- input3.c ------------------------------------------------------------------

    fn juncdata(&mut self, t: &[String]) -> R {
        if self.nnodes == self.max_nodes() {
            return Err(fail(200, None, Fix::Drop));
        }
        self.add_node(&t[0], true)?;
        self.njuncs += 1;
        self.nnodes += 1;
        let n = t.len();
        if n > 1 && getfloat(&t[1]).is_none() {
            return Err(fail(202, Some(1), Fix::Keep(1)));
        }
        if n > 2 && getfloat(&t[2]).is_none() {
            return Err(fail(202, Some(2), Fix::Keep(2)));
        }
        if n > 3 && self.findpattern(&t[3]) < 0 {
            return Err(fail(205, Some(3), Fix::Keep(3)));
        }
        Ok(())
    }

    fn tankdata(&mut self, t: &[String]) -> R {
        if self.ntanks == self.max_tanks || self.nnodes == self.max_nodes() {
            return Err(fail(200, None, Fix::Drop));
        }
        self.add_node(&t[0], false)?;
        self.ntanks += 1;
        self.nnodes += 1;
        let n = t.len();
        let mut err: Option<(u16, Option<usize>)> = None;
        if n < 2 {
            // C then reads an uninitialised elevation.
            return Err(fail(201, None, Fix::Keep(1)));
        }
        if getfloat(&t[1]).is_none() {
            err = Some((202, Some(1)));
        }
        if n <= 3 {
            if n == 3 && err.is_none() && self.findpattern(&t[2]) < 0 {
                err = Some((205, Some(2)));
            }
        } else if err.is_none() {
            if n < 6 {
                err = Some((201, None));
            } else {
                for (i, tok) in t.iter().enumerate().take(6).skip(2) {
                    if err.is_none() {
                        match getfloat(tok) {
                            None => err = Some((202, Some(i))),
                            Some(v) if v < 0.0 => err = Some((209, Some(i))),
                            _ => {}
                        }
                    }
                }
                if n >= 7 && err.is_none() {
                    match getfloat(&t[6]) {
                        None => err = Some((202, Some(6))),
                        Some(v) if v < 0.0 => err = Some((209, Some(6))),
                        _ => {}
                    }
                }
                if err.is_none()
                    && n >= 8
                    && !t[7].is_empty()
                    && !t[7].starts_with('*')
                    && !self.findcurve(&t[7])
                {
                    err = Some((206, Some(7)));
                }
                if err.is_none() && n >= 9 && !kw(&t[8], "YES") && !kw(&t[8], "NO") {
                    err = Some((213, Some(8)));
                }
            }
        }
        let Some((code, tok)) = err else {
            return Ok(());
        };
        let fix = match tok {
            Some(1) => Fix::Keep(1),
            Some(2) if n <= 3 => Fix::Keep(2),
            None => Fix::Keep(2),
            // A bad level or diameter leaves the diameter 0: a reservoir whose initial
            // level is whatever was read.
            Some(k) if (2..=5).contains(&k) => {
                let mut r = t[..k].to_vec();
                r.resize(6, "0".to_string());
                Fix::Replace(r)
            }
            Some(k) => Fix::Keep(k),
        };
        Err(fail(code, tok, fix))
    }

    fn pipedata(&mut self, t: &[String]) -> R {
        if self.nlinks == self.max_links() {
            return Err(fail(200, None, Fix::Drop));
        }
        let n = t.len();
        if n < 3 {
            return Ok(());
        }
        self.ends(t)?;
        self.add_link(&t[0], LinkType::Pipe)?;
        let positive = |s: &str| getfloat(s).is_some_and(|v| v > 0.0);
        let nonneg = |s: &str| getfloat(s).is_some_and(|v| v >= 0.0);
        for (k, tok) in t.iter().enumerate().take(6).skip(3) {
            if !positive(tok) {
                return Err(fail(202, Some(k), Fix::Keep(k)));
            }
        }
        let status = |s: &str| {
            if kw(s, "CV") {
                Some(LinkType::CvPipe)
            } else if kw(s, "CLOSED") || kw(s, "OPEN") {
                Some(LinkType::Pipe)
            } else {
                None
            }
        };
        if n > 6 {
            match status(&t[6]) {
                Some(LinkType::CvPipe) => self.set_link_kind(&t[0], LinkType::CvPipe),
                Some(_) => {}
                None if !nonneg(&t[6]) => return Err(fail(202, Some(6), Fix::Keep(6))),
                None => {}
            }
        }
        if n > 7 {
            if !nonneg(&t[6]) {
                return Err(fail(202, Some(6), Fix::Keep(7)));
            }
            match status(&t[7]) {
                Some(LinkType::CvPipe) => self.set_link_kind(&t[0], LinkType::CvPipe),
                Some(_) => {}
                None => return Err(fail(213, Some(7), Fix::Keep(7))),
            }
        }
        Ok(())
    }

    fn pumpdata(&mut self, t: &[String]) -> R {
        if self.nlinks == self.max_links() || self.npumps == self.max_pumps {
            return Err(fail(200, None, Fix::Drop));
        }
        let n = t.len();
        if n < 3 {
            return Ok(());
        }
        self.ends(t)?;
        self.add_link(&t[0], LinkType::Pump)?;
        self.npumps += 1;
        let mut m = 4;
        while m < n {
            let key = &t[m - 1];
            let keep = Fix::Keep(m - 1);
            if kw(key, "POWER") {
                if !getfloat(&t[m]).is_some_and(|v| v > 0.0) {
                    return Err(fail(202, Some(m), keep));
                }
            } else if kw(key, "HEAD") {
                if !self.findcurve(&t[m]) {
                    return Err(fail(206, Some(m), keep));
                }
            } else if kw(key, "PATT") {
                if self.findpattern(&t[m]) < 0 {
                    return Err(fail(205, Some(m), keep));
                }
            } else if kw(key, "SPEE") {
                if !getfloat(&t[m]).is_some_and(|v| v >= 0.0) {
                    return Err(fail(202, Some(m), keep));
                }
            } else {
                return Err(fail(201, Some(m - 1), keep));
            }
            m += 2;
        }
        Ok(())
    }

    fn valvedata(&mut self, t: &[String]) -> R {
        if self.nlinks == self.max_links() || self.nvalves == self.max_valves {
            return Err(fail(200, None, Fix::Drop));
        }
        let n = t.len();
        if n < 5 {
            return Ok(());
        }
        let (j1, j2) = self.ends(t)?;
        let types = [
            ("PRV", LinkType::Prv),
            ("PSV", LinkType::Psv),
            ("PBV", LinkType::Pbv),
            ("FCV", LinkType::Fcv),
            ("TCV", LinkType::Tcv),
            ("GPV", LinkType::Gpv),
            ("PCV", LinkType::Pcv),
        ];
        let Some(kind) = types.iter().find(|(w, _)| kw(&t[4], w)).map(|(_, k)| *k) else {
            return Err(fail(213, Some(4), Fix::Drop));
        };
        if self.valvecheck(kind, j1, j2) {
            return Err(if self.is_tank_key(j1) {
                fail(219, Some(1), Fix::Drop)
            } else if self.is_tank_key(j2) {
                fail(219, Some(2), Fix::Drop)
            } else {
                fail(220, None, Fix::Drop)
            });
        }
        self.add_link(&t[0], kind)?;
        self.nvalves += 1;
        self.valves.push((self.nlinks, kind, j1, j2));
        if !getfloat(&t[3]).is_some_and(|v| v > 0.0) {
            let diameter = if self.si { "254" } else { "10" };
            let r = vec![
                t[0].clone(),
                t[1].clone(),
                t[2].clone(),
                diameter.to_string(),
                t[4].clone(),
            ];
            return Err(fail(202, Some(3), Fix::Replace(r)));
        }
        if n > 5 {
            if kind == LinkType::Gpv {
                if !self.findcurve(&t[5]) {
                    return Err(fail(206, Some(5), Fix::Keep(5)));
                }
            } else if getfloat(&t[5]).is_none() {
                return Err(fail(202, Some(5), Fix::Keep(5)));
            }
        }
        if n > 6 && !getfloat(&t[6]).is_some_and(|v| v >= 0.0) {
            return Err(fail(202, Some(6), Fix::Keep(6)));
        }
        if n > 7 && kind == LinkType::Pcv && !self.findcurve(&t[7]) {
            return Err(fail(206, Some(7), Fix::Keep(7)));
        }
        Ok(())
    }

    /// `valvecheck`: a PRV, PSV or FCV may not touch a tank or conflict with another
    /// such valve. (C passes the index of the last link read as the new valve's, so the
    /// last link, if a valve, escapes the check.)
    fn valvecheck(&self, kind: LinkType, j1: usize, j2: usize) -> bool {
        use LinkType::{Fcv, Prv, Psv};
        if !matches!(kind, Prv | Psv | Fcv) {
            return false;
        }
        if self.is_tank_key(j1) || self.is_tank_key(j2) {
            return true;
        }
        let index = self.nlinks;
        self.valves.iter().any(|&(link, vtype, vj1, vj2)| {
            link != index
                && ((vtype == Prv && kind == Prv && (vj2 == j2 || vj2 == j1 || vj1 == j2))
                    || (vtype == Psv && kind == Psv && (vj1 == j1 || vj1 == j2 || vj2 == j1))
                    || (vtype == Psv && kind == Prv && vj1 == j2)
                    || (vtype == Prv && kind == Psv && vj2 == j1)
                    || (vtype == Fcv && kind == Psv && vj2 == j1)
                    || (vtype == Fcv && kind == Prv && vj1 == j2)
                    || (vtype == Psv && kind == Fcv && vj1 == j2)
                    || (vtype == Prv && kind == Fcv && vj2 == j1))
        })
    }

    fn patterndata(&mut self, t: &[String]) -> R {
        let n = t.len() - 1;
        if n < 1 {
            return Err(fail(201, None, Fix::Prepass));
        }
        if self.prev_pat.as_deref() != Some(t[0].as_str()) && self.findpattern(&t[0]) <= 0 {
            return Err(fail(205, Some(0), Fix::Prepass));
        }
        for j in 1..=n {
            if getfloat(&t[j]).is_none() {
                // The pattern has already grown by one factor of 1.0 per token.
                let mut r = t[..j].to_vec();
                r.extend(std::iter::repeat_n("1".to_string(), n - j + 1));
                return Err(fail(202, Some(j), Fix::Replace(r)));
            }
        }
        self.prev_pat = Some(t[0].clone());
        Ok(())
    }

    fn curvedata(&mut self, t: &[String]) -> R {
        if t.len() < 3 {
            return Err(fail(201, None, Fix::Prepass));
        }
        if getfloat(&t[1]).is_none() {
            return Err(fail(202, Some(1), Fix::Prepass));
        }
        if getfloat(&t[2]).is_none() {
            return Err(fail(202, Some(2), Fix::Prepass));
        }
        if self.prev_curve.as_deref() != Some(t[0].as_str()) && !self.findcurve(&t[0]) {
            return Err(fail(206, Some(0), Fix::Prepass));
        }
        self.prev_curve = Some(t[0].clone());
        Ok(())
    }

    fn demanddata(&mut self, t: &[String]) -> R {
        let n = t.len();
        if n < 2 {
            return Err(fail(201, None, Fix::Drop));
        }
        if getfloat(&t[1]).is_none() {
            return Err(fail(202, Some(1), Fix::Drop));
        }
        let j = self.nodes.get(&t[0]).ok_or(fail(203, Some(0), Fix::Drop))?;
        if !j.junction {
            return Ok(());
        }
        if n >= 3 && self.findpattern(&t[2]) < 0 {
            return Err(fail(205, Some(2), Fix::Drop));
        }
        Ok(())
    }

    fn controldata(&mut self, t: &mut [String]) -> R {
        let mut n = t.len();
        if n < 6 {
            return Err(fail(201, None, Fix::Drop));
        }
        if kw(&t[n - 1], "DISABLED") {
            n -= 1;
        }
        let link = self
            .links
            .get(&t[1])
            .ok_or(fail(204, Some(1), Fix::Drop))?
            .kind;
        if link == LinkType::CvPipe {
            return Err(fail(207, Some(1), Fix::Drop));
        }
        let mut setting: Option<f64> = None;
        if kw(&t[2], "OPEN") {
            if link == LinkType::Pump {
                setting = Some(1.0);
            }
        } else if kw(&t[2], "CLOSED") {
            if link == LinkType::Pump {
                setting = Some(0.0);
            }
        } else if link == LinkType::Gpv {
            return Err(fail(207, Some(1), Fix::Drop));
        } else {
            setting = Some(getfloat(&t[2]).ok_or(fail(202, Some(2), Fix::Drop))?);
        }
        if matches!(link, LinkType::Pump | LinkType::Pipe) && setting.is_some_and(|s| s < 0.0) {
            return Err(fail(211, Some(2), Fix::Drop));
        }
        let timer = kw(&t[4], "TIME") || kw(&t[4], "CLOCKTIME");
        if timer {
            let time = if n == 6 {
                hour(&mut t[5], "")
            } else {
                let units = t[6].clone();
                hour(&mut t[5], &units)
            };
            if time < 0.0 {
                return Err(fail(213, Some(5), Fix::Drop));
            }
        } else {
            if n < 8 {
                return Err(fail(201, None, Fix::Drop));
            }
            if !self.nodes.contains_key(&t[5]) {
                return Err(fail(203, Some(5), Fix::Drop));
            }
            if !kw(&t[6], "BELOW") && !kw(&t[6], "ABOVE") {
                return Err(fail(213, Some(6), Fix::Drop));
            }
            if getfloat(&t[7]).is_none() {
                return Err(fail(202, Some(7), Fix::Drop));
            }
        }
        self.ncontrols += 1;
        if self.ncontrols > self.max_controls {
            return Err(fail(200, None, Fix::Drop));
        }
        Ok(())
    }

    fn sourcedata(&mut self, t: &[String]) -> R {
        let n = t.len();
        if n < 2 {
            return Err(fail(201, None, Fix::Drop));
        }
        if !self.nodes.contains_key(&t[0]) {
            return Err(fail(203, Some(0), Fix::Drop));
        }
        let typed = ["CONCEN", "MASS", "SETPOINT", "FLOWPACED"]
            .iter()
            .any(|w| kw(&t[1], w));
        let i = if typed { 2 } else { 1 };
        // (C reads past the last token when a type has no value.)
        if t.get(i).and_then(|s| getfloat(s)).is_none() {
            return Err(fail(if i == 1 { 213 } else { 202 }, Some(i), Fix::Drop));
        }
        if n > i + 1 && !t[i + 1].is_empty() && t[i + 1] != "*" && self.findpattern(&t[i + 1]) < 0 {
            return Err(fail(205, Some(i + 1), Fix::Drop));
        }
        Ok(())
    }

    fn emitterdata(&mut self, t: &[String]) -> R {
        if t.len() < 2 {
            return Err(fail(201, None, Fix::Drop));
        }
        let j = self.nodes.get(&t[0]).ok_or(fail(203, Some(0), Fix::Drop))?;
        if !j.junction {
            return Ok(());
        }
        match getfloat(&t[1]) {
            None => Err(fail(202, Some(1), Fix::Drop)),
            Some(k) if k < 0.0 => Err(fail(209, Some(1), Fix::Drop)),
            _ => Ok(()),
        }
    }

    fn leakagedata(&mut self, t: &[String]) -> R {
        if t.len() < 3 {
            return Err(fail(201, None, Fix::Drop));
        }
        let l = self.links.get(&t[0]).ok_or(fail(203, Some(0), Fix::Drop))?;
        if !matches!(l.kind, LinkType::CvPipe | LinkType::Pipe) {
            return Ok(());
        }
        match getfloat(&t[1]) {
            None => return Err(fail(202, Some(1), Fix::Drop)),
            Some(c) if c < 0.0 => return Err(fail(209, Some(1), Fix::Drop)),
            _ => {}
        }
        match getfloat(&t[2]) {
            None => Err(fail(202, Some(2), Fix::Drop)),
            // (C blames the first coefficient for a negative second one.)
            Some(c) if c < 0.0 => Err(fail(209, Some(1), Fix::Drop)),
            _ => Ok(()),
        }
    }

    fn qualdata(&mut self, t: &[String]) -> R {
        if self.nnodes == 0 {
            return Err(fail(203, Some(0), Fix::Drop));
        }
        let n = t.len();
        if n < 2 {
            return Ok(());
        }
        let v = if n == 2 {
            if !self.nodes.contains_key(&t[0]) {
                return Err(fail(203, Some(0), Fix::Drop));
            }
            1
        } else {
            2
        };
        match getfloat(&t[v]) {
            None => Err(fail(202, Some(v), Fix::Drop)),
            Some(c) if c < 0.0 => Err(fail(209, Some(v), Fix::Drop)),
            _ => Ok(()),
        }
    }

    fn reactdata(&mut self, t: &[String]) -> R {
        let n = t.len();
        if n < 3 {
            return Ok(());
        }
        let last = n - 1;
        let value = || getfloat(&t[last]).ok_or(fail(202, Some(last), Fix::Drop));
        if kw(&t[0], "ORDER") {
            let y = value()?;
            if kw(&t[1], "BULK") || kw(&t[1], "TANK") {
                return Ok(());
            }
            if kw(&t[1], "WALL") {
                return if y == 0.0 || y == 1.0 {
                    Ok(())
                } else {
                    Err(fail(213, Some(last), Fix::Drop))
                };
            }
            return Err(fail(213, Some(1), Fix::Drop));
        }
        if kw(&t[0], "ROUG") || kw(&t[0], "LIMIT") {
            return value().map(|_| ());
        }
        if kw(&t[0], "GLOB") {
            value()?;
            if kw(&t[1], "BULK") || kw(&t[1], "WALL") {
                return Ok(());
            }
            return Err(fail(213, Some(1), Fix::Drop));
        }
        if !kw(&t[0], "BULK") && !kw(&t[0], "WALL") && !kw(&t[0], "TANK") {
            return Err(fail(213, Some(0), Fix::Drop));
        }
        value().map(|_| ())
    }

    fn mixingdata(&mut self, t: &[String]) -> R {
        if self.nnodes == 0 {
            return Err(fail(203, Some(0), Fix::Drop));
        }
        let n = t.len();
        if n < 2 {
            return Ok(());
        }
        let j = self.nodes.get(&t[0]).ok_or(fail(203, Some(0), Fix::Drop))?;
        if j.junction {
            return Ok(());
        }
        let Some(m) = findmatch(&t[1], &["MIXED", "2COMP", "FIFO", "LIFO"]) else {
            return Err(fail(213, Some(1), Fix::Drop));
        };
        if m == 1 && n == 3 && getfloat(&t[2]).is_none() {
            return Err(fail(202, Some(2), Fix::Drop));
        }
        Ok(())
    }

    fn statusdata(&mut self, t: &[String]) -> R {
        if self.nlinks == 0 {
            return Err(fail(204, Some(0), Fix::Drop));
        }
        let n = t.len() - 1;
        if n < 1 {
            return Err(fail(201, None, Fix::Drop));
        }
        let fixed = kw(&t[n], "OPEN") || kw(&t[n], "CLOSED");
        if !fixed {
            match getfloat(&t[n]) {
                None => return Err(fail(202, Some(n), Fix::Drop)),
                Some(y) if y < 0.0 => return Err(fail(211, Some(n), Fix::Drop)),
                _ => {}
            }
        }
        if n == 1 {
            let l = self.links.get(&t[0]).ok_or(fail(204, Some(0), Fix::Drop))?;
            if l.kind == LinkType::CvPipe || (l.kind == LinkType::Gpv && !fixed) {
                return Err(fail(207, Some(0), Fix::Drop));
            }
        }
        Ok(())
    }

    fn energydata(&mut self, t: &[String]) -> R {
        let n = t.len();
        if n < 3 {
            return Err(fail(201, None, Fix::Drop));
        }
        if kw(&t[0], "DEMAN") {
            return match getfloat(&t[2]) {
                None => Err(fail(202, Some(2), Fix::Drop)),
                Some(y) if y < 0.0 => Err(fail(213, Some(2), Fix::Drop)),
                _ => Ok(()),
            };
        }
        let global = if kw(&t[0], "GLOB") {
            true
        } else if kw(&t[0], "Pump") {
            if n < 4 {
                return Err(fail(201, None, Fix::Drop));
            }
            match self.links.get(&t[1]) {
                Some(l) if l.kind == LinkType::Pump => {}
                _ => return Err(fail(216, Some(1), Fix::Drop)),
            }
            false
        } else {
            return Err(fail(213, Some(0), Fix::Drop));
        };
        let (key, last) = (&t[n - 2], n - 1);
        if kw(key, "PRICE") {
            return match getfloat(&t[last]) {
                None => Err(fail(202, Some(last), Fix::Drop)),
                Some(y) if y < 0.0 => Err(fail(217, Some(last), Fix::Drop)),
                _ => Ok(()),
            };
        }
        if kw(key, "PATT") {
            if self.findpattern(&t[last]) < 0 {
                return Err(fail(205, Some(last), Fix::Drop));
            }
            return Ok(());
        }
        if kw(key, "EFFI") {
            if global {
                return match getfloat(&t[last]) {
                    None => Err(fail(202, Some(last), Fix::Drop)),
                    Some(y) if y <= 0.0 => Err(fail(217, Some(last), Fix::Drop)),
                    _ => Ok(()),
                };
            }
            if !self.findcurve(&t[last]) {
                return Err(fail(206, Some(last), Fix::Drop));
            }
            return Ok(());
        }
        Err(fail(201, None, Fix::Drop))
    }

    fn reportdata(&mut self, t: &[String]) -> R {
        let ntok = t.len();
        let n = ntok - 1;
        if n < 1 {
            return Err(fail(201, None, Fix::Drop));
        }
        if kw(&t[0], "PAGE") {
            let y = getfloat(&t[n]).ok_or(fail(202, Some(n), Fix::Drop))?;
            // (Not a range check: C lets NaN through.)
            #[allow(clippy::manual_range_contains)]
            if y < 0.0 || y > 255.0 {
                return Err(fail(213, Some(n), Fix::Drop));
            }
            #[allow(clippy::cast_possible_truncation)]
            {
                self.page_size = y as i32;
            }
            return Ok(());
        }
        if kw(&t[0], "STATUS") || kw(&t[0], "SUMM") || kw(&t[0], "ENER") {
            return Ok(());
        }
        if kw(&t[0], "MESS") {
            if kw(&t[n], "NO") {
                self.messages = false;
            }
            if kw(&t[n], "YES") {
                self.messages = true;
            }
            return Ok(());
        }
        for (word, nodes) in [("NODE", true), ("LINK", false)] {
            if kw(&t[0], word) {
                if kw(&t[n], "NONE") || kw(&t[n], "ALL") {
                    return Ok(());
                }
                let code = if nodes { 203 } else { 204 };
                let count = if nodes { self.nnodes } else { self.nlinks };
                if count == 0 {
                    return Err(fail(code, Some(1), Fix::Drop));
                }
                for (i, id) in t.iter().enumerate().take(n + 1).skip(1) {
                    let found = if nodes {
                        self.nodes.contains_key(id)
                    } else {
                        self.links.contains_key(id)
                    };
                    if !found {
                        return Err(fail(code, Some(i), Fix::Drop));
                    }
                }
                return Ok(());
            }
        }
        let fields = [
            "Elevation",
            "Demand",
            "Head",
            "Pressure",
            "Quality",
            "Length",
            "Diameter",
            "Flow",
            "Velocity",
            "Headloss",
            "Quality",
            "State",
            "Setting",
            "Reaction",
            "F-Factor",
        ];
        let field = t[0].eq_ignore_ascii_case("Headloss") || findmatch(&t[0], &fields).is_some();
        if field {
            if ntok == 1 || kw(&t[1], "YES") || kw(&t[1], "NO") {
                return Ok(());
            }
            if ntok < 3 {
                return Err(fail(201, None, Fix::Drop));
            }
            if !kw(&t[1], "BELOW") && !kw(&t[1], "ABOVE") && !kw(&t[1], "PREC") {
                return Err(fail(213, Some(1), Fix::Drop));
            }
            if getfloat(&t[2]).is_none() {
                return Err(fail(202, Some(2), Fix::Drop));
            }
            return Ok(());
        }
        if kw(&t[0], "FILE") {
            return Ok(());
        }
        Err(fail(201, None, Fix::Drop))
    }

    fn timedata(&mut self, t: &mut [String]) -> R {
        let n = t.len() - 1;
        if n < 1 {
            return Err(fail(201, None, Fix::Drop));
        }
        if kw(&t[0], "STAT") {
            let ok = ["NONE", "NO", "AVERAGE", "MINIMUM", "MAXIMUM", "RANGE"]
                .iter()
                .any(|w| kw(&t[n], w));
            return if ok {
                Ok(())
            } else {
                Err(fail(213, Some(n), Fix::Drop))
            };
        }
        if getfloat(&t[n]).is_none() && hour(&mut t[n], "") < 0.0 {
            let units = t[n].clone();
            if hour(&mut t[n - 1], &units) < 0.0 {
                return Err(fail(213, Some(n - 1), Fix::Drop));
            }
        }
        for word in ["DURA", "HYDR", "QUAL", "RULE", "MINI"] {
            if kw(&t[0], word) {
                return Ok(());
            }
        }
        if kw(&t[0], "PATT") || kw(&t[0], "REPO") {
            if kw(&t[1], "TIME") || kw(&t[1], "STAR") {
                return Ok(());
            }
            return Err(fail(213, Some(1), Fix::Drop));
        }
        if kw(&t[0], "STAR") {
            return Ok(());
        }
        Err(fail(213, Some(0), Fix::Drop))
    }

    fn optiondata(&mut self, t: &[String]) -> R {
        let n = t.len() - 1;
        match self.optionchoice(t, n)? {
            true => Ok(()),
            false => self.optionvalue(t, n),
        }
    }

    /// `optionchoice`: `Ok(true)` if the line was a named choice, `Ok(false)` if not.
    fn optionchoice(&mut self, t: &[String], n: usize) -> Result<bool, Fail> {
        let bad = |i| Err(fail(213, Some(i), Fix::Drop));
        if kw(&t[0], "UNIT") {
            if n < 1 {
                return Ok(true);
            }
            let words = [
                "CFS", "GPM", "AFD", "MGD", "IMGD", "LPS", "LPM", "CMH", "CMD", "MLD", "CMS", "SI",
            ];
            let Some(i) = findmatch(&t[1], &words) else {
                return bad(1);
            };
            self.si = i >= 5;
        } else if kw(&t[0], "PRESSURE") {
            if n < 1 {
                return Ok(true);
            }
            if kw(&t[1], "EXP") {
                return Ok(false);
            }
            if findmatch(&t[1], &["PSI", "KPA", "METERS", "BAR", "FEET"]).is_none() {
                return bad(1);
            }
        } else if kw(&t[0], "HEADL") {
            if n < 1 {
                return Ok(true);
            }
            if findmatch(&t[1], &["H-W", "D-W", "C-M"]).is_none() {
                return bad(1);
            }
        } else if kw(&t[0], "HYDR") {
            if n < 2 {
                return Ok(true);
            }
            if !kw(&t[1], "USE") && !kw(&t[1], "SAVE") {
                return bad(1);
            }
        } else if kw(&t[0], "QUAL") {
            if n < 1 {
                return Ok(true);
            }
            let trace =
                !kw(&t[1], "NONE") && !kw(&t[1], "CHEM") && !kw(&t[1], "AGE") && kw(&t[1], "TRACE");
            if trace {
                if n < 2 {
                    return Err(fail(201, None, Fix::Drop));
                }
                if !self.nodes.contains_key(&t[2]) {
                    return Err(fail(212, Some(2), Fix::Drop));
                }
            }
        } else if kw(&t[0], "MAP") || kw(&t[0], "VERI") || kw(&t[0], "PATT") {
            return Ok(true);
        } else if kw(&t[0], "UNBA") {
            if n < 1 {
                return Ok(true);
            }
            if !kw(&t[1], "STOP") && !kw(&t[1], "CONT") {
                return bad(1);
            }
        } else if kw(&t[0], "DEMAND") {
            if n < 2 {
                return Ok(true);
            }
            if !kw(&t[1], "MODEL") {
                return Ok(false);
            }
            if findmatch(&t[2], &["DDA", "PDA"]).is_none() {
                return bad(2);
            }
        } else if kw(&t[0], "BACK") {
            if n < 2 {
                return Ok(true);
            }
            if !kw(&t[1], "ALLOW") {
                return Ok(false);
            }
            if findmatch(&t[2], &["NO", "YES"]).is_none() {
                return bad(2);
            }
        } else {
            return Ok(false);
        }
        Ok(true)
    }

    fn optionvalue(&mut self, t: &[String], n: usize) -> R {
        let tok0 = &t[0];
        if kw(tok0, "SEGM") {
            return Ok(());
        }
        let nvalue = if ["SPEC", "EMIT", "DEMAND", "MINI", "REQ", "PRESSURE", "PREC"]
            .iter()
            .any(|w| kw(tok0, w))
        {
            2
        } else {
            1
        };
        if n < nvalue {
            return Ok(());
        }
        let bad = |code| Err(fail(code, Some(nvalue), Fix::Drop));
        let Some(y) = getfloat(&t[nvalue]) else {
            return bad(202);
        };
        if kw(tok0, "TOLER") || kw(tok0, "DIFF") {
            return if y < 0.0 { bad(213) } else { Ok(()) };
        }
        if kw(tok0, "DAMPLIMIT") {
            return Ok(());
        }
        if kw(tok0, "FLOWCHANGE") || kw(tok0, "HEADERROR") {
            return if y < 0.0 { bad(213) } else { Ok(()) };
        }
        if kw(tok0, "MINI") {
            if y < 0.0 {
                return bad(213);
            }
            #[allow(clippy::float_cmp)]
            if self.preq == MIN_PDIFF {
                self.preq = y + MIN_PDIFF;
            } else if self.preq - y < MIN_PDIFF {
                return bad(208);
            }
            self.pmin = y;
            return Ok(());
        }
        if kw(tok0, "REQ") {
            if y < 0.0 {
                return bad(213);
            }
            if y - self.pmin < MIN_PDIFF {
                return bad(208);
            }
            self.preq = y;
            return Ok(());
        }
        if kw(tok0, "PRESSURE") {
            return if y < 0.0 { bad(213) } else { Ok(()) };
        }
        if y <= 0.0 {
            return bad(213);
        }
        for w in ["VISC", "SPEC", "TRIAL", "ACCU", "HTOL", "QTOL"] {
            if kw(tok0, w) {
                return Ok(());
            }
        }
        if kw(tok0, "RQTOL") {
            // (C does not say which token.)
            return if y >= 1.0 {
                Err(fail(213, None, Fix::Drop))
            } else {
                Ok(())
            };
        }
        for w in ["CHECKFREQ", "MAXCHECK", "EMIT", "DEMAND"] {
            if kw(tok0, w) {
                return Ok(());
            }
        }
        Err(fail(201, None, Fix::Drop))
    }

    fn tagdata(&mut self, t: &[String]) -> R {
        if t.len() < 3 {
            return Err(fail(201, None, Fix::Drop));
        }
        // (C blames the keyword for an undefined node or link.)
        if kw(&t[0], "NODE") && !self.nodes.contains_key(&t[1]) {
            return Err(fail(203, Some(0), Fix::Drop));
        }
        if !kw(&t[0], "NODE") && kw(&t[0], "LINK") && !self.links.contains_key(&t[1]) {
            return Err(fail(203, Some(0), Fix::Drop));
        }
        Ok(())
    }

    // ---- rules.c -------------------------------------------------------------------

    /// `ruledata`: `Err` carries the clause's own error code.
    fn ruledata(&mut self, t: &mut [String], chunk: usize) -> Result<(), u16> {
        let words = [
            "RULE", "IF", "AND", "OR", "THEN", "ELSE", "PRIO", "DISABLED",
        ];
        let state = self.rule_state;
        let err = match findmatch(&t[0], &words) {
            None => 201,
            Some(0) => {
                if t.len() != 2 {
                    201
                } else {
                    self.nrules += 1;
                    let label: String =
                        String::from_utf8_lossy(&t[1].as_bytes()[..t[1].len().min(MAX_ID)])
                            .into_owned();
                    self.rules.truncate(self.nrules);
                    self.rules.push((label, Vec::new()));
                    self.rule_state = Some(RuleState::Rule);
                    0
                }
            }
            Some(1) => {
                if state != Some(RuleState::Rule) {
                    221
                } else {
                    self.rule_state = Some(RuleState::If);
                    self.newpremise(t)
                }
            }
            Some(2) => match state {
                Some(RuleState::If) => self.newpremise(t),
                Some(RuleState::Then | RuleState::Else) => self.newaction(t),
                _ => 221,
            },
            Some(3) => {
                if state == Some(RuleState::If) {
                    self.newpremise(t)
                } else {
                    221
                }
            }
            Some(4) => {
                if state != Some(RuleState::If) {
                    221
                } else {
                    self.rule_state = Some(RuleState::Then);
                    self.newaction(t)
                }
            }
            Some(5) => {
                if state != Some(RuleState::Then) {
                    221
                } else {
                    self.rule_state = Some(RuleState::Else);
                    self.newaction(t)
                }
            }
            Some(6) => {
                if !matches!(state, Some(RuleState::Then | RuleState::Else)) {
                    221
                } else {
                    self.rule_state = Some(RuleState::Priority);
                    // (C reads past the last token when there is no value.)
                    if t.get(1).and_then(|s| getfloat(s)).is_some() {
                        0
                    } else {
                        202
                    }
                }
            }
            Some(_) => {
                if !matches!(
                    state,
                    Some(RuleState::Then | RuleState::Else | RuleState::Priority)
                ) {
                    221
                } else {
                    0
                }
            }
        };
        if err != 0 {
            self.rule_state = Some(RuleState::Error);
            return Err(err);
        }
        if let Some(r) = self.rules.get_mut(self.nrules) {
            r.1.push(chunk);
        }
        Ok(())
    }

    fn newpremise(&self, t: &mut [String]) -> u16 {
        let ntok = t.len();
        if ntok != 5 && ntok != 6 {
            return 201;
        }
        let objects = [
            "Junc", "Reser", "Tank", "Pipe", "Pump", "Valve", "NODE", "LINK", "SYSTEM",
        ];
        let vars = [
            "DEMAND",
            "HEAD",
            "GRADE",
            "LEVEL",
            "PRESSURE",
            "FLOW",
            "STATUS",
            "SETTING",
            "POWER",
            "TIME",
            "CLOCKTIME",
            "FILLTIME",
            "DRAINTIME",
        ];
        let object = findmatch(&t[1], &objects);
        let system = object == Some(8);
        let v = if system {
            let v = findmatch(&t[2], &vars);
            if !matches!(v, Some(0 | 9 | 10)) {
                return 201;
            }
            v
        } else {
            let Some(v) = findmatch(&t[3], &vars) else {
                return 201;
            };
            match object {
                Some(0..=2 | 6) => {
                    let Some(j) = self.nodes.get(&t[2]) else {
                        return 203;
                    };
                    match v {
                        0..=4 => {}
                        11 | 12 if !j.junction => {}
                        _ => return 201,
                    }
                }
                Some(3..=5 | 7) => {
                    if !self.links.contains_key(&t[2]) {
                        return 204;
                    }
                    if !(5..=7).contains(&v) {
                        return 201;
                    }
                }
                _ => return 201,
            }
            Some(v)
        };
        let m = if system { 3 } else { 4 };
        let ops = [
            "=", "<>", "<=", ">=", "<", ">", "IS", "NOT", "BELOW", "ABOVE",
        ];
        if findmatch(&t[m], &ops).is_none() {
            return 201;
        }
        if matches!(v, Some(9 | 10)) {
            let units = if ntok == 6 {
                t[5].clone()
            } else {
                String::new()
            };
            if hour(&mut t[4], &units) * 3600.0 < 0.0 {
                return 202;
            }
        } else if !matches!(
            findmatch(&t[ntok - 1], &["XXXX", "OPEN", "CLOSED", "ACTIVE"]),
            Some(1..)
        ) && getfloat(&t[ntok - 1]).is_none()
        {
            return 202;
        }
        0
    }

    fn newaction(&self, t: &[String]) -> u16 {
        if t.len() != 6 {
            return 201;
        }
        let Some(l) = self.links.get(&t[2]) else {
            return 204;
        };
        if l.kind == LinkType::CvPipe {
            return 207;
        }
        if matches!(
            findmatch(&t[5], &["XXXX", "OPEN", "CLOSED", "ACTIVE"]),
            Some(1..)
        ) {
            return 0;
        }
        match getfloat(&t[5]) {
            None => 202,
            Some(x) if x < 0.0 => 202,
            Some(_) if l.kind == LinkType::Gpv => 202,
            Some(_) => 0,
        }
    }
}

/// `addpattern` and `addcurve`: a new ID in order of first appearance.
fn register(ids: &mut HashMap<String, usize>, id: &str) -> Result<(), u16> {
    if !ids.contains_key(id) {
        if id.len() > MAX_ID {
            return Err(252);
        }
        let n = ids.len() + 1;
        ids.insert(id.to_string(), n);
    }
    Ok(())
}

/// Node keys for `valvecheck`'s comparisons: junctions below, tanks from here up.
const TANK_KEY: usize = usize::MAX / 2 + 1;

fn node_key(n: &NodeInfo) -> usize {
    if n.junction {
        n.index
    } else {
        TANK_KEY + n.index
    }
}

/// Read a file as EPANET does: its input errors and the partly read network's file.
pub fn check_inp(text: &str) -> Check {
    let chunks = fgets_lines(text);
    let mut c = Checker::new();
    let mut out = Check {
        messages: true,
        // Each piece EPANET reads is a line of its own.
        lines: chunks
            .iter()
            .map(|(s, _)| {
                if s.ends_with('\n') {
                    s.clone()
                } else {
                    format!("{s}\n")
                }
            })
            .collect(),
        ..Check::default()
    };
    if let Err(code) = c.netsize(&chunks) {
        out.fatal = Some(code);
        return out;
    }

    let mut sect: Option<Sect> = None;
    for (ci, (text, line_no)) in chunks.iter().enumerate() {
        let parsed = tokenize(text);
        let mut t = parsed.tokens;
        if t.is_empty() {
            continue;
        }
        if t[0].starts_with('[') {
            match find_section(&t[0]) {
                Some(Sect::End) => {
                    // EPANET stops reading here.
                    out.lines.truncate(ci + 1);
                    break;
                }
                Some(s) => sect = Some(s),
                None => {
                    sect = None;
                    out.errors.push(InputError {
                        line: *line_no,
                        code: 299,
                        token: t[0].clone(),
                        section: None,
                        text: text.clone(),
                        rule: None,
                        page_size: c.page_size,
                        title: c.titles.first().cloned().unwrap_or_default(),
                    });
                }
            }
            continue;
        }
        let Some(s) = sect else {
            continue;
        };
        if s == Sect::Rules {
            if c.rule_state == Some(RuleState::Error) {
                // Every rule line after a bad one is ignored.
                out.lines[ci] = String::new();
                continue;
            }
            if let Err(code) = c.ruledata(&mut t, ci) {
                let label = (c.nrules > 0).then(|| c.rules[c.nrules].0.clone());
                // deleterule: the rule being read goes, with every line read for it.
                if c.nrules > 0 {
                    for &k in &c.rules[c.nrules].1 {
                        out.lines[k] = String::new();
                    }
                    c.rules.truncate(c.nrules);
                    c.nrules -= 1;
                }
                out.lines[ci] = String::new();
                out.errors.push(InputError {
                    line: *line_no,
                    code: 200,
                    token: String::new(),
                    section: Some(section_name(Sect::Rules)),
                    text: text.clone(),
                    rule: Some(RuleError {
                        code,
                        label,
                        clause: t.join(" "),
                    }),
                    page_size: c.page_size,
                    title: c.titles.first().cloned().unwrap_or_default(),
                });
            }
            continue;
        }
        let r = match s {
            Sect::Title => {
                if c.titles.len() < 3 {
                    let line = text.strip_suffix('\n').unwrap_or(text);
                    let b = line.as_bytes();
                    c.titles
                        .push(String::from_utf8_lossy(&b[..b.len().min(TITLE_LEN)]).into_owned());
                }
                Ok(())
            }
            Sect::Junctions => c.juncdata(&t),
            Sect::Reservoirs | Sect::Tanks => c.tankdata(&t),
            Sect::Pipes => c.pipedata(&t),
            Sect::Pumps => c.pumpdata(&t),
            Sect::Valves => c.valvedata(&t),
            Sect::Patterns => c.patterndata(&t),
            Sect::Curves => c.curvedata(&t),
            Sect::Demands => c.demanddata(&t),
            Sect::Controls => c.controldata(&mut t),
            Sect::Sources => c.sourcedata(&t),
            Sect::Emitters => c.emitterdata(&t),
            Sect::Leakage => c.leakagedata(&t),
            Sect::Quality => c.qualdata(&t),
            Sect::Status => c.statusdata(&t),
            Sect::Energy => c.energydata(&t),
            Sect::Reactions => c.reactdata(&t),
            Sect::Mixing => c.mixingdata(&t),
            Sect::Report => c.reportdata(&t),
            Sect::Times => c.timedata(&mut t),
            Sect::Options => c.optiondata(&t),
            Sect::Tags => c.tagdata(&t),
            Sect::Roughness
            | Sect::Coordinates
            | Sect::Vertices
            | Sect::Labels
            | Sect::Backdrop
            | Sect::Rules
            | Sect::End => Ok(()),
        };
        if let Err(f) = r {
            let comment = parsed.comment.as_deref();
            out.lines[ci] = match &f.fix {
                Fix::Drop => String::new(),
                Fix::Keep(k) => join_tokens(&t[..(*k).min(t.len())], comment),
                Fix::Replace(r) => join_tokens(r, comment),
                Fix::Prepass => first_word(text).map_or(String::new(), |w| format!("{w}\n")),
            };
            out.errors.push(InputError {
                line: *line_no,
                code: f.code,
                token: f.tok.and_then(|i| t.get(i).cloned()).unwrap_or_default(),
                section: Some(section_name(s)),
                text: text.clone(),
                rule: None,
                page_size: c.page_size,
                title: c.titles.first().cloned().unwrap_or_default(),
            });
        }
    }
    out.messages = c.messages;
    out.page_size = c.page_size;
    out.title = c.titles.first().cloned().unwrap_or_default();
    out
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn codes(text: &str) -> Vec<(usize, u16, String)> {
        check_inp(text)
            .errors
            .iter()
            .map(|e| (e.line, e.code, e.token.clone()))
            .collect()
    }

    const NET: &str = "[JUNCTIONS]\nJ1 10 1\nJ2 20\n[RESERVOIRS]\nR1 100\n[PIPES]\nP1 R1 J1 100 12 100\nP2 J1 J2 100 12 100\n";

    #[test]
    fn a_clean_file_has_no_errors() {
        let c = check_inp(NET);
        assert!(c.errors.is_empty());
        assert_eq!(c.code(), 0);
        assert_eq!(c.repaired(), NET);
    }

    #[test]
    fn a_long_line_is_repaired_into_the_pieces_epanet_reads() {
        let long = format!(" J9 {}", "1 ".repeat(600));
        let c = check_inp(&format!("[PATTERNS]\n1 1\n[JUNCTIONS]\n{long}\n"));
        assert!(c.repaired().lines().all(|l| l.len() < 1024));
        assert!(c.repaired().lines().count() > 4);
    }

    #[test]
    fn reports_errors_in_file_order_with_the_blamed_token() {
        let text = "[JUNCTIONS]\nJ1 10 x\nJ2 20\nJ1 5\n[RESERVOIRS]\nR1 100\n[PIPES]\nP1 J1 J2 100 abc 100\nP2 J2 J9 100 12 100\n[BOGUS]\nfoo\n[OPTIONS]\nFOO BAR\n";
        assert_eq!(
            codes(text),
            [
                (2, 202, "x".into()),
                (4, 215, "J1".into()),
                (8, 202, "abc".into()),
                (9, 203, "J9".into()),
                (10, 299, "[BOGUS]".into()),
                (13, 202, "BAR".into()),
            ]
        );
        let c = check_inp(text);
        assert_eq!(c.code(), 200);
        assert_eq!(
            c.errors[0].report_lines(),
            [
                "Error 202: illegal numeric value x in [JUNCTIONS] section:",
                "J1 10 x\n"
            ]
        );
        assert_eq!(
            c.errors[4].report_lines()[0],
            "Error 299: invalid section keyword [BOGUS]: section contents ignored."
        );
    }

    #[test]
    fn partly_read_lines_keep_what_epanet_took() {
        let text = "[JUNCTIONS]\nJ1 10 x ;main\nJ2 20\n[TANKS]\nT1 5 1 x 9 20\n[PIPES]\nP1 J1 J2 100 abc 100\nP2 J1 J2 100 12 100 CV OPEN\n[PATTERNS]\nPA 1 2 z 4\n";
        let r = check_inp(text).repaired();
        assert!(r.contains("J1 10 ;main\n"), "{r}");
        assert!(r.contains("T1 5 1 0 0 0\n"), "{r}");
        assert!(r.contains("P1 J1 J2 100\n"), "{r}");
        assert!(r.contains("PA 1 2 1 1\n"), "{r}");
    }

    #[test]
    fn controls_follow_file_order_and_hour_cuts_the_token() {
        let text = "[CONTROLS]\nLINK P1 OPEN AT TIME 2\n[JUNCTIONS]\nJ1 1\nJ2 1\n[PIPES]\nP1 J1 J2\n[CONTROLS]\nLINK P1 OPEN AT TIME 2:xx\nLINK P1 OPEN AT TIME 2\n";
        assert_eq!(codes(text), [(2, 204, "P1".into()), (9, 213, "2".into())]);
    }

    #[test]
    fn a_bad_rule_drops_itself_and_every_later_rule() {
        let text = "[JUNCTIONS]\nJ1 1\nJ2 1\n[PIPES]\nP1 J1 J2\n[RULES]\nRULE A\nIF NODE J1 PRESSURE > 1\nTHEN PIPE P1 STATUS IS CLOSED\nRULE B\nIF NODE J9 PRESSURE > 1\nTHEN PIPE P1 STATUS IS CLOSED\nRULE C\nIF NODE J1 PRESSURE > 1\nTHEN PIPE P1 STATUS IS OPEN\n";
        let c = check_inp(text);
        assert_eq!(c.errors.len(), 1);
        let e = &c.errors[0];
        assert_eq!(
            e.report_lines(),
            [
                "Input Error 203: undefined node in following line of Rule B:",
                "IF NODE J9 PRESSURE > 1",
                "Error 200: one or more errors in input file  in [RULES] section:",
                "IF NODE J9 PRESSURE > 1\n",
            ]
        );
        let r = c.repaired();
        assert!(r.contains("RULE A") && !r.contains("RULE B") && !r.contains("RULE C"));
    }

    #[test]
    fn long_pattern_ids_stop_epanet_before_reading() {
        let c = check_inp("[PATTERNS]\nP0123456789012345678901234567890123 1 2\n");
        assert_eq!(c.fatal, Some(252));
        assert!(c.errors.is_empty());
    }

    #[test]
    fn getfloat_follows_strtod() {
        assert_eq!(getfloat("1.5"), Some(1.5));
        assert_eq!(getfloat(""), Some(0.0));
        assert_eq!(getfloat("0x10"), Some(16.0));
        assert_eq!(getfloat(".5"), Some(0.5));
        assert_eq!(getfloat("5."), Some(5.0));
        assert_eq!(getfloat("1e3"), Some(1000.0));
        assert_eq!(getfloat("1e"), None);
        assert_eq!(getfloat("abc"), None);
        assert_eq!(getfloat("inf"), Some(f64::INFINITY));
        assert!(getfloat("nan").is_some_and(f64::is_nan));
        assert_eq!(getfloat(" 7"), Some(7.0));
        assert_eq!(getfloat("7 "), None);
    }

    #[test]
    fn hour_reads_clock_times() {
        let mut t = "1:30".to_string();
        assert!((hour(&mut t, "PM") - 13.5).abs() < 1e-12);
        assert_eq!(t, "1");
        let mut t = "90".to_string();
        assert!((hour(&mut t, "MIN") - 1.5).abs() < 1e-12);
        assert_eq!(hour(&mut "x".to_string(), ""), -1.0);
    }

    #[test]
    fn lines_longer_than_epanet_reads_arrive_in_pieces() {
        let long = "x".repeat(1500);
        let pieces = fgets_lines(&format!("{long}\nnext\n"));
        assert_eq!(pieces.len(), 3);
        assert_eq!(pieces[0].0.len(), 1023);
        assert_eq!(pieces[2], ("next\n".to_string(), 2));
    }
}
