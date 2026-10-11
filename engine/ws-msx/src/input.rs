// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxinp.c, msxproj.c, msxutils.c). See LICENSES/EPANET-MSX.txt.

//! Reading an MSX input file against an EPANET network: two passes over the file as
//! in msxinp.c (count and name the objects, then parse every line), then the unit
//! conversions of msxproj.c.

use std::collections::HashMap;

use ws_solver::ToolkitData;

use crate::expr::MathExpr;
use crate::types::*;

const MAXERRS: usize = 100;
const MAXTOKS: usize = 40;
const SEPSTR: &[u8] = b" \t\n\r";

// Input error codes (401 - 410).
const ERR_ITEMS: i32 = 402;
const ERR_KEYWORD: i32 = 403;
const ERR_NUMBER: i32 = 404;
const ERR_NAME: i32 = 405;
const ERR_RESERVED_NAME: i32 = 406;
const ERR_DUP_NAME: i32 = 407;
const ERR_DUP_EXPR: i32 = 408;
const ERR_MATH_EXPR: i32 = 409;

const INP_ERROR_TXT: [&str; 11] = [
    "",
    "Error 401 (too many characters)",
    "Error 402 (too few input items)",
    "Error 403 (invalid keyword)",
    "Error 404 (invalid numeric value)",
    "Error 405 (reference to undefined object)",
    "Error 406 (illegal use of a reserved name)",
    "Error 407 (name already used by another object)",
    "Error 408 (species already assigned an expression)",
    "Error 409 (illegal math expression)",
    "Error 410 (option no longer supported)",
];

/// `MSXutils_match`: does `substr` start `s` (after leading blanks), ignoring case?
pub fn utils_match(s: &str, substr: &str) -> bool {
    if substr.is_empty() {
        return false;
    }
    let s = s.trim_start_matches(' ').as_bytes();
    let sub = substr.as_bytes();
    if s.len() < sub.len() {
        return false;
    }
    s[..sub.len()].eq_ignore_ascii_case(sub)
}

/// `MSXutils_findmatch`: index of the first keyword that `s` starts with.
pub fn findmatch(s: &str, keywords: &[&str]) -> i32 {
    for (i, k) in keywords.iter().enumerate() {
        if utils_match(s, k) {
            return i as i32;
        }
    }
    -1
}

/// `MSXutils_strcomp`: case-insensitive equality.
pub fn strcomp(s1: &str, s2: &str) -> bool {
    s1.eq_ignore_ascii_case(s2)
}

/// `MSXutils_getDouble`: `strtod` that must consume the whole string.
pub fn get_double(s: &str) -> Option<f64> {
    let t = s.trim_start_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c']);
    if t.is_empty() {
        // strtod converts nothing and leaves the end pointer at the terminating NUL.
        return Some(0.0);
    }
    let lower = t.to_ascii_lowercase();
    let body = lower.trim_start_matches(['+', '-']);
    if body.starts_with("0x") {
        return parse_hex_float(t);
    }
    t.parse::<f64>().ok()
}

/// strtod's hexadecimal form (rare in input files, but accepted by the C code).
fn parse_hex_float(t: &str) -> Option<f64> {
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let rest = &rest[2..];
    let (mant, exp) = match rest.find(['p', 'P']) {
        Some(i) => (&rest[..i], rest[i + 1..].parse::<i32>().ok()?),
        None => (rest, 0),
    };
    let (ip, fp) = mant.split_once('.').unwrap_or((mant, ""));
    if ip.is_empty() && fp.is_empty() {
        return None;
    }
    let mut v = 0.0f64;
    for c in ip.chars() {
        v = v * 16.0 + f64::from(c.to_digit(16)?);
    }
    let mut scale = 1.0 / 16.0;
    for c in fp.chars() {
        v += f64::from(c.to_digit(16)?) * scale;
        scale /= 16.0;
    }
    let v = v * 2f64.powi(exp);
    Some(if neg { -v } else { v })
}

/// `MSXutils_getInt`: a number rounded toward zero after a 0.01 nudge.
pub fn get_int(s: &str) -> Option<i32> {
    let mut x = get_double(s)?;
    if x < 0.0 {
        x -= 0.01;
    } else {
        x += 0.01;
    }
    Some(x as i32)
}

/// The longest prefix of `s` that `strtod` would read.
fn numeric_prefix(s: &str) -> &str {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    let start = i;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let mut digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return "";
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if j < b.len() && b[j].is_ascii_digit() {
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            i = j;
        }
    }
    &s[start..i]
}

/// C's `atof`.
pub fn atof(s: &str) -> f64 {
    numeric_prefix(s).parse::<f64>().unwrap_or(0.0)
}

/// C's `atoi`.
pub fn atoi(s: &str) -> i32 {
    let p = numeric_prefix(s);
    let int_part = p.split(['.', 'e', 'E']).next().unwrap_or("");
    int_part.parse::<i64>().map(|v| v as i32).unwrap_or(0)
}

/// `strcspn` over a NUL-terminated buffer.
fn strcspn(s: &[u8], from: usize, set: &[u8]) -> usize {
    let mut n = 0;
    while let Some(&c) = s.get(from + n) {
        if c == 0 || set.contains(&c) {
            break;
        }
        n += 1;
    }
    n
}

/// `getTokens`: split a line on blanks, after cutting it at a `;` comment; text in
/// double quotes is one token.
pub fn get_tokens(line: &str) -> Vec<String> {
    let mut s: Vec<u8> = line.as_bytes().to_vec();
    if let Some(c) = s.iter().position(|&c| c == b';') {
        s.truncate(c);
    }
    let mut toks = Vec::new();
    let mut len = s.len() as i64;
    let mut pos = 0usize;
    while len > 0 && toks.len() < MAXTOKS {
        let mut m = strcspn(&s, pos, SEPSTR);
        if m == 0 {
            pos += 1;
        } else {
            if s.get(pos) == Some(&b'"') {
                pos += 1;
                len -= 1;
                m = strcspn(&s, pos, b"\"\n");
            }
            let end = (pos + m).min(s.len());
            let start = pos.min(end);
            toks.push(String::from_utf8_lossy(&s[start..end]).into_owned());
            pos += m + 1;
        }
        len -= m as i64 + 1;
    }
    toks
}

/// The lines `fgets(line, MAXLINE, f)` returns: each ends at a newline (kept) or after
/// MAXLINE - 1 bytes.
fn fgets_lines(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let mut j = i;
        while j < b.len() && j - i < MAXLINE - 1 {
            j += 1;
            if b[j - 1] == b'\n' {
                break;
            }
        }
        out.push(String::from_utf8_lossy(&b[i..j]).into_owned());
        i = j;
    }
    out
}

/// The first token as `strtok(line, " \t\n\r")` finds it.
fn first_token(line: &str) -> Option<&str> {
    line.split([' ', '\t', '\n', '\r']).find(|t| !t.is_empty())
}

/// Object-name lookups (the hash tables of msxproj.c), case sensitive.
#[derive(Default)]
struct Names {
    tables: [HashMap<String, usize>; MAX_OBJECTS],
}

impl Names {
    fn find(&self, kind: usize, id: &str) -> usize {
        self.tables[kind].get(id).copied().unwrap_or(0)
    }

    fn add(&mut self, kind: usize, id: &str, n: usize) {
        self.tables[kind].entry(id.to_string()).or_insert(n);
    }
}

/// The result of reading an MSX file: the model, or an error code with the messages
/// the C code writes to the EPANET report.
pub struct Opened {
    pub model: Model,
    pub messages: Vec<String>,
}

pub struct InputError {
    pub code: i32,
    pub messages: Vec<String>,
}

struct Reader<'a> {
    m: Model,
    names: Names,
    net: &'a ToolkitData,
    node_index: HashMap<&'a str, usize>,
    link_index: HashMap<&'a str, usize>,
    tok: Vec<String>,
    term_array: Vec<Vec<f64>>,
    messages: Vec<String>,
}

/// Open an MSX project (`MSXproj_open` up to the adjacency lists). `file_name` is
/// only used in the "Processing MSX input file" message.
pub fn open(net: &ToolkitData, text: &str, file_name: &str) -> Result<Opened, InputError> {
    let mut r = Reader {
        m: Model::default(),
        names: Names::default(),
        net,
        node_index: net
            .node_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i + 1))
            .collect(),
        link_index: net
            .link_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i + 1))
            .collect(),
        tok: Vec::new(),
        term_array: Vec::new(),
        messages: Vec::new(),
    };
    r.set_defaults();
    let lines = fgets_lines(text);
    let mut err = r.count_msx_objects(&lines, file_name);
    if err == 0 {
        r.count_net_objects();
        r.create_objects();
        r.m.dispersion_flag = false;
        r.read_net_data();
        err = r.read_msx_data(&lines);
    }
    if err == 0 {
        r.convert_units();
        if r.m.dispersion_flag {
            r.m.dispersion.relative_viscosity = f64::from(net.relative_viscosity);
            r.m.dispersion.viscosity = f64::from(net.relative_viscosity) * 1.1e-5;
        }
    }
    if err != 0 {
        return Err(InputError {
            code: err,
            messages: r.messages,
        });
    }
    Ok(Opened {
        model: r.m,
        messages: r.messages,
    })
}

impl Reader<'_> {
    fn ntok(&self) -> usize {
        self.tok.len()
    }

    fn t(&self, i: usize) -> &str {
        self.tok.get(i).map(String::as_str).unwrap_or("")
    }

    fn node_index(&self, id: &str) -> Option<usize> {
        self.node_index.get(id).copied()
    }

    fn link_index(&self, id: &str) -> Option<usize> {
        self.link_index.get(id).copied()
    }

    /// `setDefaults`
    fn set_defaults(&mut self) {
        let m = &mut self.m;
        m.rpt_file.clear();
        m.title.clear();
        m.nobjects = [0; MAX_OBJECTS];
        m.unitsflag = US;
        m.flowflag = 1; // GPM
        m.statflag = SERIES;
        m.def_rtol = 0.001;
        m.def_atol = 0.01;
        m.solver = EUL;
        m.coupling = NO_COUPLING;
        m.compiler = 0;
        m.area_units = FT2;
        m.rate_units = 3; // DAYS
        m.qstep = 300 * 1000;
        m.rstep = 3600;
        m.rstart = 0;
    }

    fn write_inp_err_msg(&mut self, errcode: i32, sect: i32, line: &str, line_count: usize) {
        let sect_word = usize::try_from(sect)
            .ok()
            .and_then(|s| MSX_SECT_WORDS.get(s))
            .copied()
            .unwrap_or("");
        let msg = if (401..=410).contains(&errcode) {
            format!(
                "{} at line {} of {}] section:",
                INP_ERROR_TXT[(errcode - 400) as usize],
                line_count,
                sect_word
            )
        } else {
            format!("Error Code = {errcode}")
        };
        self.messages.push(String::new());
        self.messages.push(msg);
        self.messages.push(line.to_string());
    }

    /// `getNewSection`
    fn new_section(tok: &str, sect: &mut i32) -> bool {
        if tok.starts_with('[') {
            *sect = findmatch(tok, &MSX_SECT_WORDS);
            return true;
        }
        false
    }

    /// `MSXinp_countMsxObjects`
    fn count_msx_objects(&mut self, lines: &[String], file_name: &str) -> i32 {
        self.messages
            .push(format!("Processing MSX input file {file_name}"));
        self.messages.push(String::new());
        let mut sect = -1;
        let mut errsum = 0;
        let mut errcode = 0;
        for (n, line) in lines.iter().enumerate() {
            errcode = 0;
            let Some(tok) = first_token(line) else {
                continue;
            };
            if tok.starts_with(';') {
                continue;
            }
            if Self::new_section(tok, &mut sect) {
                continue;
            }
            let tok = tok.to_string();
            if sect == 1 {
                errcode = self.add_species(line);
            }
            if sect == 2 {
                errcode = self.add_coeff(line);
            }
            if sect == 3 {
                errcode = self.add_term(&tok);
            }
            if sect == 9 {
                self.add_pattern(&tok);
            }
            if errcode != 0 {
                self.write_inp_err_msg(errcode, sect, line, n + 1);
                errsum += 1;
                if errsum >= MAXERRS {
                    break;
                }
            }
        }
        if errsum > 0 {
            return ERR_MSX_INPUT;
        }
        errcode
    }

    fn add_species(&mut self, line: &str) -> i32 {
        self.tok = get_tokens(line);
        if self.ntok() < 2 {
            return ERR_ITEMS;
        }
        let id = self.t(1).to_string();
        let e = self.check_id(&id);
        if e != 0 {
            return e;
        }
        let n = self.m.nobjects[SPECIES] + 1;
        self.names.add(SPECIES, &id, n);
        self.m.nobjects[SPECIES] += 1;
        0
    }

    fn add_coeff(&mut self, line: &str) -> i32 {
        self.tok = get_tokens(line);
        if self.ntok() < 2 {
            return ERR_ITEMS;
        }
        let k = if utils_match(self.t(0), "PARAM") {
            PARAMETER
        } else if utils_match(self.t(0), "CONST") {
            CONSTANT
        } else {
            return ERR_KEYWORD;
        };
        let id = self.t(1).to_string();
        let e = self.check_id(&id);
        if e != 0 {
            return e;
        }
        let n = self.m.nobjects[k] + 1;
        self.names.add(k, &id, n);
        self.m.nobjects[k] += 1;
        0
    }

    fn add_term(&mut self, id: &str) -> i32 {
        let e = self.check_id(id);
        if e == 0 {
            let n = self.m.nobjects[TERM] + 1;
            self.names.add(TERM, id, n);
            self.m.nobjects[TERM] += 1;
        }
        e
    }

    fn add_pattern(&mut self, id: &str) {
        if self.names.find(PATTERN, id) == 0 {
            let n = self.m.nobjects[PATTERN] + 1;
            self.names.add(PATTERN, id, n);
            self.m.nobjects[PATTERN] += 1;
        }
    }

    /// `checkID`
    fn check_id(&self, id: &str) -> i32 {
        if HYD_VAR_WORDS[1..].iter().any(|w| strcomp(id, w)) {
            return ERR_RESERVED_NAME;
        }
        if self.names.find(SPECIES, id) > 0
            || self.names.find(TERM, id) > 0
            || self.names.find(PARAMETER, id) > 0
            || self.names.find(CONSTANT, id) > 0
        {
            return ERR_DUP_NAME;
        }
        0
    }

    /// `MSXinp_countNetObjects`
    fn count_net_objects(&mut self) {
        self.m.nobjects[NODE] = self.net.node_ids.len();
        self.m.nobjects[TANK] = self.net.tanks.len();
        self.m.nobjects[LINK] = self.net.link_ids.len();
    }

    /// `createObjects`
    fn create_objects(&mut self) {
        let m = &mut self.m;
        let nsp = m.nobjects[SPECIES];
        let npar = m.nobjects[PARAMETER];
        m.nodes = vec![
            NodeData {
                sources: Vec::new(),
                c0: vec![0.0; nsp + 1],
                tank: 0,
                rpt: false,
            };
            m.nobjects[NODE] + 1
        ];
        m.links = vec![
            LinkData {
                c0: vec![0.0; nsp + 1],
                param: vec![0.0; npar + 1],
                ..LinkData::default()
            };
            m.nobjects[LINK] + 1
        ];
        m.tanks = vec![
            TankData {
                param: vec![0.0; npar + 1],
                ..TankData::default()
            };
            m.nobjects[TANK] + 1
        ];
        m.species = vec![
            Species {
                precision: 2,
                ..Species::default()
            };
            nsp + 1
        ];
        m.terms = vec![Term::default(); m.nobjects[TERM] + 1];
        m.params = vec![Coeff::default(); npar + 1];
        m.consts = vec![Coeff::default(); m.nobjects[CONSTANT] + 1];
        m.patterns = vec![Pattern::default(); m.nobjects[PATTERN] + 1];
        m.c0 = vec![0.0; nsp + 1];
        m.max_segments = MAXSEGMENTS;
        m.dispersion.peclet_limit = 1000.0;
        m.dispersion.diffus = 1.29e-8;
        m.dispersion.md = vec![-1.0; nsp + 1];
        m.dispersion.ld = vec![-1.0; nsp + 1];
        m.dispersion.md[0] = 0.0;
        m.dispersion.ld[0] = 0.0;
        m.node_ids = self.net.node_ids.clone();
        m.link_ids = self.net.link_ids.clone();
    }

    /// `MSXinp_readNetData`
    fn read_net_data(&mut self) {
        let net = self.net;
        let m = &mut self.m;
        m.flowflag = net.flow_units;
        m.unitsflag = if m.flowflag >= 5 { SI } else { US };
        m.qstep = net.quality_step * 1000;
        m.rstep = net.report_step;
        m.rstart = net.report_start;
        m.pstep = net.pattern_step;
        m.pstart = net.pattern_start;
        m.statflag = net.statistic;
        let n = net.junctions;
        for (k0, t) in net.tanks.iter().enumerate() {
            let k = k0 + 1;
            let i = n + k;
            m.nodes[i].tank = k;
            m.tanks[k].node = i;
            m.tanks[k].a = if t.reservoir { 0.0 } else { 1.0 };
            m.tanks[k].v0 = f64::from(t.init_volume);
            m.tanks[k].mix_model = t.mix_model as i32;
            m.tanks[k].v_mix = f64::from(t.mix_zone_volume);
        }
        for (i0, l) in net.links.iter().enumerate() {
            let link = &mut m.links[i0 + 1];
            link.n1 = l.n1;
            link.n2 = l.n2;
            link.diam = f64::from(l.diameter);
            link.len = f64::from(l.length);
            link.roughness = f64::from(l.roughness);
        }
    }

    /// `MSXinp_readMsxData`
    fn read_msx_data(&mut self, lines: &[String]) -> i32 {
        let nt = self.m.nobjects[TERM] + 1;
        self.term_array = vec![vec![0.0; nt]; nt];
        let mut sect = -1;
        let mut errsum = 0;
        for (n, line) in lines.iter().enumerate() {
            self.tok = get_tokens(line);
            if self.tok.is_empty() || self.t(0).starts_with(';') {
                continue;
            }
            let t0 = self.t(0).to_string();
            if Self::new_section(&t0, &mut sect) {
                continue;
            }
            let inperr = self.parse_line(sect, line);
            if inperr > 0 {
                errsum += 1;
                self.write_inp_err_msg(inperr, sect, line, n + 1);
            }
            if errsum >= MAXERRS {
                break;
            }
        }
        if self.check_cyclic_terms() {
            errsum += 1;
        }
        if errsum > 0 {
            return ERR_MSX_INPUT;
        }
        0
    }

    fn parse_line(&mut self, sect: i32, line: &str) -> i32 {
        match sect {
            0 => {
                self.m.title = line.to_string();
                0
            }
            10 => self.parse_option(),
            1 => self.parse_species(),
            2 => self.parse_coeff(),
            3 => self.parse_term(),
            4 => self.parse_expression(LINK),
            5 => self.parse_expression(TANK),
            6 => self.parse_source(),
            7 => self.parse_quality(),
            8 => self.parse_parameter(),
            9 => self.parse_pattern(),
            11 => self.parse_report(),
            12 => self.parse_diffu(),
            _ => 0,
        }
    }

    fn parse_option(&mut self) -> i32 {
        if self.ntok() < 2 {
            return 0;
        }
        let k = findmatch(self.t(0), &OPTION_TYPE_WORDS);
        let v1 = self.t(1).to_string();
        match k {
            0 => {
                let k = findmatch(&v1, &AREA_UNITS_WORDS);
                if k < 0 {
                    return ERR_KEYWORD;
                }
                self.m.area_units = k;
            }
            1 => {
                let k = findmatch(&v1, &TIME_UNITS_WORDS);
                if k < 0 {
                    return ERR_KEYWORD;
                }
                self.m.rate_units = k;
            }
            2 => {
                let k = findmatch(&v1, &SOLVER_TYPE_WORDS);
                if k < 0 {
                    return ERR_KEYWORD;
                }
                self.m.solver = k;
            }
            3 => {
                let k = findmatch(&v1, &COUPLING_WORDS);
                if k < 0 {
                    return ERR_KEYWORD;
                }
                self.m.coupling = k;
            }
            4 => {
                let Some(v) = get_double(&v1) else {
                    return ERR_NUMBER;
                };
                if v < 0.001 {
                    return ERR_NUMBER;
                }
                self.m.qstep = (v * 1000.0).round() as i64;
            }
            5 => match get_double(&v1) {
                Some(v) => self.m.def_rtol = v,
                None => return ERR_NUMBER,
            },
            6 => match get_double(&v1) {
                Some(v) => self.m.def_atol = v,
                None => return ERR_NUMBER,
            },
            7 => {
                let k = findmatch(&v1, &COMPILER_WORDS);
                if k < 0 {
                    return ERR_KEYWORD;
                }
                self.m.compiler = k;
            }
            9 => {
                let v = atof(&v1);
                if v <= 0.0 {
                    return ERR_NUMBER;
                }
                self.m.dispersion.peclet_limit = if v >= 1.0 { v } else { 1.0 };
            }
            8 => {
                let k = atoi(&v1);
                if k <= 0 {
                    return ERR_NUMBER;
                }
                self.m.max_segments = k.max(50);
            }
            _ => return ERR_KEYWORD,
        }
        0
    }

    fn parse_species(&mut self) -> i32 {
        if self.ntok() < 3 {
            return ERR_ITEMS;
        }
        let i = self.names.find(SPECIES, self.t(1));
        if i == 0 {
            return ERR_NAME;
        }
        let id = self.t(1).to_string();
        let kind = if utils_match(self.t(0), "BULK") {
            BULK
        } else if utils_match(self.t(0), "WALL") {
            WALL
        } else {
            self.m.species[i].id = id;
            return ERR_KEYWORD;
        };
        let units: String = self.t(2).chars().take(MAXUNITS).collect();
        let a_tol = if self.ntok() >= 4 {
            get_double(self.t(3))
        } else {
            Some(0.0)
        };
        let r_tol = if self.ntok() >= 5 {
            get_double(self.t(4))
        } else {
            Some(0.0)
        };
        let s = &mut self.m.species[i];
        s.id = id;
        s.kind = kind;
        s.units = units;
        s.a_tol = 0.0;
        s.r_tol = 0.0;
        match a_tol {
            Some(v) => s.a_tol = v,
            None => return ERR_NUMBER,
        }
        match r_tol {
            Some(v) => s.r_tol = v,
            None => return ERR_NUMBER,
        }
        0
    }

    fn parse_coeff(&mut self) -> i32 {
        if self.ntok() < 2 {
            return 0;
        }
        if utils_match(self.t(0), "PARAM") {
            let i = self.names.find(PARAMETER, self.t(1));
            if i == 0 {
                return ERR_NAME;
            }
            self.m.params[i].id = self.t(1).to_string();
            if self.ntok() >= 3 {
                let Some(x) = get_double(self.t(2)) else {
                    return ERR_NUMBER;
                };
                self.m.params[i].value = x;
                for l in &mut self.m.links[1..] {
                    l.param[i] = x;
                }
                for t in &mut self.m.tanks[1..] {
                    t.param[i] = x;
                }
            }
            0
        } else if utils_match(self.t(0), "CONST") {
            let i = self.names.find(CONSTANT, self.t(1));
            if i == 0 {
                return ERR_NAME;
            }
            self.m.consts[i].id = self.t(1).to_string();
            self.m.consts[i].value = 0.0;
            if self.ntok() >= 3 {
                match get_double(self.t(2)) {
                    Some(v) => self.m.consts[i].value = v,
                    None => return ERR_NUMBER,
                }
            }
            0
        } else {
            ERR_KEYWORD
        }
    }

    /// `getVariableCode`: species, terms, parameters, constants and then hydraulic
    /// variables are numbered consecutively from 1.
    fn variable_code(names: &Names, m: &Model, id: &str) -> i32 {
        let n = &m.nobjects;
        let j = names.find(SPECIES, id);
        if j >= 1 {
            return j as i32;
        }
        let j = names.find(TERM, id);
        if j >= 1 {
            return (n[SPECIES] + j) as i32;
        }
        let j = names.find(PARAMETER, id);
        if j >= 1 {
            return (n[SPECIES] + n[TERM] + j) as i32;
        }
        let j = names.find(CONSTANT, id);
        if j >= 1 {
            return (n[SPECIES] + n[TERM] + n[PARAMETER] + j) as i32;
        }
        let j = findmatch(id, &HYD_VAR_WORDS);
        if j >= 1 {
            return (n[SPECIES] + n[TERM] + n[PARAMETER] + n[CONSTANT]) as i32 + j;
        }
        -1
    }

    fn create_expr(&self, s: &str) -> Option<MathExpr> {
        let names = &self.names;
        let m = &self.m;
        MathExpr::create(s, &|id: &str| Self::variable_code(names, m, id))
    }

    fn parse_term(&mut self) -> i32 {
        if self.ntok() < 2 {
            return 0;
        }
        let i = self.names.find(TERM, self.t(0));
        self.m.terms[i].id = self.t(0).to_string();
        let mut s = String::new();
        for j in 1..self.ntok() {
            s.push_str(self.t(j));
            let k = self.names.find(TERM, self.t(j));
            if k > 0 {
                self.term_array[i][k] = 1.0;
            }
        }
        match self.create_expr(&s) {
            Some(e) => {
                self.m.terms[i].expr = Some(e);
                0
            }
            None => ERR_MATH_EXPR,
        }
    }

    fn parse_expression(&mut self, class: usize) -> i32 {
        if self.ntok() < 3 {
            return ERR_ITEMS;
        }
        let k = findmatch(self.t(0), &EXPR_TYPE_WORDS);
        if k < 0 {
            return ERR_KEYWORD;
        }
        let i = self.names.find(SPECIES, self.t(1));
        if i < 1 {
            return ERR_NAME;
        }
        if class == LINK && self.m.species[i].pipe_expr_type != NO_EXPR {
            return ERR_DUP_EXPR;
        }
        if class == TANK && self.m.species[i].tank_expr_type != NO_EXPR {
            return ERR_DUP_EXPR;
        }
        let s: String = self.tok[2..].concat();
        let Some(expr) = self.create_expr(&s) else {
            return ERR_MATH_EXPR;
        };
        let sp = &mut self.m.species[i];
        if class == LINK {
            sp.pipe_expr = Some(expr);
            sp.pipe_expr_type = k;
        } else {
            sp.tank_expr = Some(expr);
            sp.tank_expr_type = k;
        }
        0
    }

    fn parse_quality(&mut self) -> i32 {
        if self.ntok() < 3 {
            return ERR_ITEMS;
        }
        let i = if utils_match(self.t(0), "GLOBAL") {
            1
        } else if utils_match(self.t(0), "NODE") {
            2
        } else if utils_match(self.t(0), "LINK") {
            3
        } else {
            return ERR_KEYWORD;
        };
        let k = if i >= 2 { 2 } else { 1 };
        let m = self.names.find(SPECIES, self.t(k));
        if m == 0 {
            return ERR_NAME;
        }
        if i >= 2 && self.ntok() < 4 {
            return ERR_ITEMS;
        }
        let k = if i >= 2 { 3 } else { 2 };
        let Some(x) = get_double(self.t(k)) else {
            return ERR_NUMBER;
        };
        let bulk = self.m.species[m].kind == BULK;
        match i {
            1 => {
                self.m.c0[m] = x;
                if bulk {
                    for n in &mut self.m.nodes[1..] {
                        n.c0[m] = x;
                    }
                }
                for l in &mut self.m.links[1..] {
                    l.c0[m] = x;
                }
            }
            2 => {
                let Some(j) = self.node_index(self.t(1)) else {
                    return ERR_NAME;
                };
                if bulk {
                    self.m.nodes[j].c0[m] = x;
                }
            }
            _ => {
                let Some(j) = self.link_index(self.t(1)) else {
                    return ERR_NAME;
                };
                self.m.links[j].c0[m] = x;
            }
        }
        0
    }

    fn parse_parameter(&mut self) -> i32 {
        if self.ntok() < 4 {
            return 0;
        }
        let i = self.names.find(PARAMETER, self.t(2));
        let Some(x) = get_double(self.t(3)) else {
            return ERR_NUMBER;
        };
        if utils_match(self.t(0), "PIPE") {
            let Some(j) = self.link_index(self.t(1)) else {
                return ERR_NAME;
            };
            self.m.links[j].param[i] = x;
        } else if utils_match(self.t(0), "TANK") {
            let Some(j) = self.node_index(self.t(1)) else {
                return ERR_NAME;
            };
            let j = self.m.nodes[j].tank;
            if j > 0 {
                self.m.tanks[j].param[i] = x;
            }
        } else {
            return ERR_KEYWORD;
        }
        0
    }

    fn parse_source(&mut self) -> i32 {
        if self.ntok() < 4 {
            return ERR_ITEMS;
        }
        let k = findmatch(self.t(0), &SOURCE_TYPE_WORDS);
        if k < 0 {
            return ERR_KEYWORD;
        }
        let Some(j) = self.node_index(self.t(1)) else {
            return ERR_NAME;
        };
        let m = self.names.find(SPECIES, self.t(2));
        if m == 0 {
            return ERR_NAME;
        }
        if self.m.species[m].kind != BULK {
            return 0;
        }
        let Some(x) = get_double(self.t(3)) else {
            return ERR_NUMBER;
        };
        let mut pat = 0;
        if self.ntok() >= 5 {
            pat = self.names.find(PATTERN, self.t(4));
            if pat == 0 {
                return ERR_NAME;
            }
        }
        let sources = &mut self.m.nodes[j].sources;
        let src = Source {
            kind: k,
            species: m,
            c0: x,
            pat,
        };
        match sources.iter_mut().find(|s| s.species == m) {
            Some(s) => *s = src,
            None => sources.insert(0, src),
        }
        0
    }

    fn parse_pattern(&mut self) -> i32 {
        if self.ntok() < 2 {
            return ERR_ITEMS;
        }
        let i = self.names.find(PATTERN, self.t(0));
        if i == 0 {
            return ERR_NAME;
        }
        self.m.patterns[i].id = self.t(0).to_string();
        for k in 1..self.ntok() {
            let Some(x) = get_double(self.t(k)) else {
                return ERR_NUMBER;
            };
            self.m.patterns[i].values.push(x);
        }
        0
    }

    fn parse_report(&mut self) -> i32 {
        if self.ntok() < 2 {
            return 0;
        }
        let k = findmatch(self.t(0), &REPORT_WORDS);
        if k < 0 {
            return ERR_KEYWORD;
        }
        match k {
            0 => {
                if strcomp(self.t(1), "ALL") {
                    for n in &mut self.m.nodes[1..] {
                        n.rpt = true;
                    }
                } else if strcomp(self.t(1), "NONE") {
                    for n in &mut self.m.nodes[1..] {
                        n.rpt = false;
                    }
                } else {
                    for i in 1..self.ntok() {
                        let Some(j) = self.node_index(self.t(i)) else {
                            return ERR_NAME;
                        };
                        self.m.nodes[j].rpt = true;
                    }
                }
            }
            1 => {
                if strcomp(self.t(1), "ALL") {
                    for l in &mut self.m.links[1..] {
                        l.rpt = true;
                    }
                } else if strcomp(self.t(1), "NONE") {
                    for l in &mut self.m.links[1..] {
                        l.rpt = false;
                    }
                } else {
                    for i in 1..self.ntok() {
                        let Some(j) = self.link_index(self.t(i)) else {
                            return ERR_NAME;
                        };
                        self.m.links[j].rpt = true;
                    }
                }
            }
            2 => {
                let j = self.names.find(SPECIES, self.t(1));
                if j == 0 {
                    return ERR_NAME;
                }
                if self.ntok() >= 3 {
                    if strcomp(self.t(2), "YES") {
                        self.m.species[j].rpt = true;
                    } else if strcomp(self.t(2), "NO") {
                        self.m.species[j].rpt = false;
                    } else {
                        return ERR_KEYWORD;
                    }
                }
                if self.ntok() >= 4 {
                    match get_int(self.t(3)) {
                        Some(p) => self.m.species[j].precision = p,
                        None => {
                            self.m.species[j].precision = 0;
                            return ERR_NUMBER;
                        }
                    }
                }
            }
            3 => self.m.rpt_file = self.t(1).to_string(),
            _ => match get_int(self.t(1)) {
                Some(p) => self.m.page_size = p,
                None => {
                    self.m.page_size = 0;
                    return ERR_NUMBER;
                }
            },
        }
        0
    }

    fn parse_diffu(&mut self) -> i32 {
        if self.ntok() < 2 {
            return ERR_ITEMS;
        }
        let m = self.names.find(SPECIES, self.t(0));
        if m == 0 {
            return ERR_NAME;
        }
        if self.m.species[m].kind != BULK {
            return 0;
        }
        let Some(x) = get_double(self.t(1)) else {
            return ERR_NUMBER;
        };
        if x < 0.0 {
            return ERR_NUMBER;
        }
        let x = x * self.m.dispersion.diffus;
        if self.ntok() > 2 && utils_match(self.t(2), "FIXED") {
            self.m.dispersion.ld[m] = x;
        } else {
            self.m.dispersion.md[m] = x;
        }
        self.m.dispersion_flag = true;
        0
    }

    /// `checkCyclicTerms`
    fn check_cyclic_terms(&mut self) -> bool {
        let n = self.m.nobjects[TERM];
        for i in 1..n {
            for j in 1..=n {
                self.term_array[0][j] = 0.0;
            }
            if self.trace_term_path(i, i, n) {
                let msg = format!(
                    "Error 410 - term {} contains a cyclic reference.",
                    self.m.terms[i].id
                );
                self.messages.push(msg);
                return true;
            }
        }
        false
    }

    fn trace_term_path(&mut self, i: usize, istar: usize, n: usize) -> bool {
        if self.term_array[0][i] == 1.0 {
            return false;
        }
        self.term_array[0][i] = 1.0;
        for j in 1..=n {
            if self.term_array[i][j] == 0.0 {
                continue;
            }
            if j == istar || self.trace_term_path(j, istar, n) {
                return true;
            }
        }
        false
    }

    /// `convertUnits`
    fn convert_units(&mut self) {
        let fcf = [
            1.0,
            GPM_PER_CFS,
            MGD_PER_CFS,
            IMGD_PER_CFS,
            AFD_PER_CFS,
            LPS_PER_CFS,
            LPM_PER_CFS,
            MLD_PER_CFS,
            CMH_PER_CFS,
            CMD_PER_CFS,
            // EPANET 2.3 added cubic meters per second, which MSX 2.0 predates.
            M3_PER_FT3,
        ];
        let rcf = [1.0, 60.0, 3600.0, 86400.0];
        let m = &mut self.m;
        if m.unitsflag == US {
            m.ucf[LENGTH_UNITS] = 1.0;
            m.ucf[DIAM_UNITS] = 12.0;
            m.ucf[VOL_UNITS] = 1.0;
        } else {
            m.ucf[LENGTH_UNITS] = M_PER_FT;
            m.ucf[DIAM_UNITS] = 1000.0 * M_PER_FT;
            m.ucf[VOL_UNITS] = M3_PER_FT3;
        }
        m.ucf[AREA_UNITS] = match m.area_units {
            M2 => M2_PER_FT2,
            CM2 => CM2_PER_FT2,
            _ => 1.0,
        };
        m.ucf[FLOW_UNITS] = fcf.get(m.flowflag as usize).copied().unwrap_or(1.0);
        m.ucf[CONC_UNITS] = L_PER_FT3;
        m.ucf[RATE_UNITS] = rcf.get(m.rate_units as usize).copied().unwrap_or(1.0);
        let (dcf, lcf, vcf) = (m.ucf[DIAM_UNITS], m.ucf[LENGTH_UNITS], m.ucf[VOL_UNITS]);
        for l in &mut m.links[1..] {
            l.diam /= dcf;
            l.len /= lcf;
        }
        for t in &mut m.tanks[1..] {
            t.v0 /= vcf;
            t.v_mix /= vcf;
        }
        let (rtol, atol) = (m.def_rtol, m.def_atol);
        for s in &mut m.species[1..] {
            if s.r_tol == 0.0 {
                s.r_tol = rtol;
            }
            if s.a_tol == 0.0 {
                s.a_tol = atol;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_follow_get_tokens() {
        assert_eq!(
            get_tokens("  RATE  AS3 -Ka*AS3 ;comment\n"),
            ["RATE", "AS3", "-Ka*AS3"]
        );
        assert_eq!(
            get_tokens("FILE \"my report.txt\" x\n"),
            ["FILE", "my report.txt", "x"]
        );
        assert!(get_tokens("   ; only a comment").is_empty());
        assert!(get_tokens("\r\n").is_empty());
    }

    #[test]
    fn keyword_matching_is_by_prefix() {
        assert!(utils_match("SPECIES", "SPECIE"));
        assert!(utils_match("  rate", "RATE"));
        assert!(!utils_match("RAT", "RATE"));
        assert_eq!(findmatch("[PIPES]", &MSX_SECT_WORDS), 4);
        assert_eq!(
            findmatch("Us", &HYD_VAR_WORDS),
            3,
            "Us matches U first, as in the C code"
        );
        assert_eq!(findmatch("FORMULA", &EXPR_TYPE_WORDS), 2);
    }

    #[test]
    fn numbers_follow_strtod_and_atoi() {
        assert_eq!(get_double("1.5e-3"), Some(1.5e-3));
        assert_eq!(get_double("12abc"), None);
        assert_eq!(get_double("0x10"), Some(16.0));
        assert_eq!(get_int("2.999"), Some(3));
        assert_eq!(get_int("-1.995"), Some(-2));
        assert_eq!(atoi("120abc"), 120);
        assert_eq!(atof("3.5xyz"), 3.5);
        assert_eq!(atof("abc"), 0.0);
    }

    #[test]
    fn fgets_splits_long_lines() {
        let long = "x".repeat(2000) + "\n";
        let lines = fgets_lines(&long);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), MAXLINE - 1);
    }
}
