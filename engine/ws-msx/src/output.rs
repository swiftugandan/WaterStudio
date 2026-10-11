// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxout.c, msxrpt.c). See LICENSES/EPANET-MSX.txt.

//! The MSX binary output file, kept in memory with the C code's layout, and the text
//! report written from it.

use ws_solver::cfmt;

use crate::fp::{max_c, min_c};
use crate::qual::{Qual, Saver};
use crate::types::*;

pub const MAGICNUMBER: i32 = 516114521;
pub const VERSION: i32 = 200000;

/// The binary results file (`OutFile`, and `TmpOutFile` when a statistic is reported).
#[derive(Clone, Debug, Default)]
pub struct Output {
    pub file: Vec<u8>,
    tmp: Vec<u8>,
    separate_tmp: bool,
    results_offset: usize,
    node_bytes_per_period: usize,
    link_bytes_per_period: usize,
    pub opened: bool,
}

fn put_i32(v: &mut Vec<u8>, x: i32) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn get_f32(v: &[u8], at: usize) -> f32 {
    v.get(at..at + 4)
        .and_then(|b| b.try_into().ok())
        .map(f32::from_le_bytes)
        .unwrap_or(0.0)
}

impl Output {
    /// `MSXout_open` and `MSXout_saveInitialResults`.
    pub fn open(&mut self, m: &Model) {
        self.file.clear();
        self.tmp.clear();
        self.separate_tmp = m.statflag != SERIES;
        self.opened = true;
        let f = &mut self.file;
        put_i32(f, MAGICNUMBER);
        put_i32(f, VERSION);
        put_i32(f, m.nobjects[NODE] as i32);
        put_i32(f, m.nobjects[LINK] as i32);
        put_i32(f, m.nobjects[SPECIES] as i32);
        put_i32(f, m.rstep as i32);
        for s in &m.species[1..] {
            put_i32(f, s.id.len() as i32);
            f.extend_from_slice(s.id.as_bytes());
            let mut units = [0u8; MAXUNITS];
            for (d, b) in units.iter_mut().zip(s.units.bytes()) {
                *d = b;
            }
            f.extend_from_slice(&units);
        }
        self.results_offset = f.len();
        self.node_bytes_per_period = m.nobjects[NODE] * m.nobjects[SPECIES] * 4;
        self.link_bytes_per_period = m.nobjects[LINK] * m.nobjects[SPECIES] * 4;
    }

    fn sink(&mut self) -> &mut Vec<u8> {
        if self.separate_tmp {
            &mut self.tmp
        } else {
            &mut self.file
        }
    }

    /// `MSXout_saveFinalResults`
    pub fn save_final_results(&mut self, m: &Model, q: &mut Qual) {
        if m.statflag != SERIES {
            self.save_stat_results(m, q);
        }
        let f = &mut self.file;
        put_i32(f, self.results_offset as i32);
        put_i32(f, q.nperiods);
        put_i32(f, 0);
        put_i32(f, MAGICNUMBER);
    }

    /// `MSXout_getNodeQual`
    pub fn node_qual(&self, m: &Model, k: usize, j: usize, sp: usize) -> f32 {
        let bp = self.results_offset
            + k * (self.node_bytes_per_period + self.link_bytes_per_period)
            + ((sp - 1) * m.nobjects[NODE] + (j - 1)) * 4;
        get_f32(&self.file, bp)
    }

    /// `MSXout_getLinkQual`
    pub fn link_qual(&self, m: &Model, k: usize, j: usize, sp: usize) -> f32 {
        let bp = self.results_offset
            + (k + 1) * self.node_bytes_per_period
            + k * self.link_bytes_per_period
            + ((sp - 1) * m.nobjects[LINK] + (j - 1)) * 4;
        get_f32(&self.file, bp)
    }

    /// `saveStatResults`
    fn save_stat_results(&mut self, m: &Model, q: &mut Qual) {
        if q.nperiods <= 0 {
            return;
        }
        let nmax = m.nobjects[NODE].max(m.nobjects[LINK]);
        let mut x = vec![0f32; nmax + 1];
        let mut stats1 = vec![0f64; nmax + 1];
        let mut stats2 = vec![0f64; nmax + 1];
        for kind in [NODE, LINK] {
            for sp in 1..=m.nsp() {
                self.stat_results(m, q, kind, sp, &mut stats1, &mut stats2, &mut x);
                let n = m.nobjects[kind];
                for v in &x[1..=n] {
                    self.file.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        q.nperiods = 1;
    }

    /// `getStatResults`
    #[allow(clippy::too_many_arguments)]
    fn stat_results(
        &self,
        m: &Model,
        q: &Qual,
        kind: usize,
        sp: usize,
        stats1: &mut [f64],
        stats2: &mut [f64],
        x: &mut [f32],
    ) {
        let n = m.nobjects[kind];
        stats1[1..=n].fill(0.0);
        stats2[1..=n].fill(0.0);
        let period = self.node_bytes_per_period + self.link_bytes_per_period;
        for k in 0..q.nperiods.max(0) as usize {
            let mut bp = k * period;
            if kind == NODE {
                bp += (sp - 1) * m.nobjects[NODE] * 4;
            } else {
                bp += self.node_bytes_per_period + (sp - 1) * m.nobjects[LINK] * 4;
            }
            for j in 1..=n {
                x[j] = get_f32(&self.tmp, bp + (j - 1) * 4);
            }
            if m.statflag == AVERAGE {
                for j in 1..=n {
                    stats1[j] += f64::from(x[j]);
                }
            } else {
                for j in 1..=n {
                    stats1[j] = min_c(stats1[j], f64::from(x[j]));
                    stats2[j] = max_c(stats2[j], f64::from(x[j]));
                }
            }
        }
        if m.statflag == AVERAGE {
            for j in 1..=n {
                stats1[j] /= f64::from(q.nperiods);
            }
        }
        if m.statflag == RANGE {
            for j in 1..=n {
                stats1[j] = (stats2[j] - stats1[j]).abs();
            }
        }
        if m.statflag == MAXIMUM {
            // The C code copies a node count's worth of entries for links too.
            for j in 1..=m.nobjects[NODE].min(stats1.len() - 1) {
                stats1[j] = stats2[j];
            }
        }
        for j in 1..=n {
            x[j] = stats1[j] as f32;
        }
    }
}

impl Saver for Output {
    /// `MSXout_saveResults`
    fn save_results(&mut self, m: &Model, q: &Qual) {
        let nsp = m.nsp();
        let mut buf = Vec::with_capacity((m.nobjects[NODE] + m.nobjects[LINK]) * nsp * 4);
        for sp in 1..=nsp {
            for j in 1..=m.nobjects[NODE] {
                buf.extend_from_slice(&(q.node_qual(m, j, sp) as f32).to_le_bytes());
            }
        }
        for sp in 1..=nsp {
            for j in 1..=m.nobjects[LINK] {
                buf.extend_from_slice(&(q.link_qual(m, j, sp) as f32).to_le_bytes());
            }
        }
        self.sink().extend_from_slice(&buf);
    }
}

const LOGO: [&str; 6] = [
    "******************************************************************",
    "*                      E P A N E T  -  M S X                     *",
    "*                   Multi-Species Water Quality                  *",
    "*                   Analysis for Pipe  Networks                  *",
    "*                           Version 2.0.0                        *",
    "******************************************************************",
];

const STATS_HDRS: [&str; 5] = [
    "",
    "Average Values  ",
    "Minimum Values  ",
    "Maximum Values  ",
    "Range of Values ",
];

/// The report writer's state (msxrpt.c).
struct Report<'a> {
    m: &'a Model,
    out: &'a Output,
    q: &'a Qual,
    text: String,
    line_num: i64,
    page_num: i64,
    hdr: [String; 5],
    id_name: String,
}

/// `MSXrpt_write`: the report text, each line written as EPANET's `writeline` (or
/// the MSX report file) would: two spaces, the line, a newline.
pub fn write_report(m: &Model, out: &Output, q: &Qual) -> Result<String, i32> {
    if q.nperiods < 1 {
        return Ok(String::new());
    }
    if !out.opened {
        return Err(ERR_OPEN_OUT_FILE);
    }
    let n = out.file.len();
    let magic = out
        .file
        .get(n.saturating_sub(4)..)
        .and_then(|b| b.try_into().ok())
        .map(i32::from_le_bytes);
    if magic != Some(MAGICNUMBER) {
        return Err(ERR_IO_OUT_FILE);
    }
    let mut r = Report {
        m,
        out,
        q,
        text: String::new(),
        line_num: 1,
        page_num: 1,
        hdr: Default::default(),
        id_name: String::new(),
    };
    r.new_page();
    for l in LOGO {
        r.write_line(l);
    }
    r.write_line("");
    let title = m.title.clone();
    r.write_line(&title);
    if m.statflag == SERIES {
        r.create_series_tables();
    } else {
        r.create_stats_tables();
    }
    r.write_mass_balance();
    r.write_line("");
    Ok(r.text)
}

const SERIES_TABLE: i32 = 0;
const STATS_TABLE: i32 = 1;

impl Report<'_> {
    fn write_line(&mut self, line: &str) {
        if self.line_num == i64::from(self.m.page_size) {
            self.new_page();
        }
        self.text.push_str("  ");
        self.text.push_str(line);
        self.text.push('\n');
        self.line_num += 1;
    }

    fn new_page(&mut self) {
        self.line_num = 1;
        let s = format!(
            "\nPage {:<3}                                             EPANET-MSX 2.0.0",
            self.page_num
        );
        self.write_line(&s);
        self.write_line("");
        if self.page_num > 1 {
            self.write_table_hdr();
        }
        self.page_num += 1;
    }

    fn create_series_tables(&mut self) {
        let m = self.m;
        for j in 1..=m.nobjects[NODE] {
            if !m.nodes[j].rpt {
                continue;
            }
            self.id_name = m.node_ids[j - 1].clone();
            self.create_table_hdr(NODE, SERIES_TABLE);
            self.write_node_table(j, SERIES_TABLE);
        }
        for j in 1..=m.nobjects[LINK] {
            if !m.links[j].rpt {
                continue;
            }
            self.id_name = m.link_ids[j - 1].clone();
            self.create_table_hdr(LINK, SERIES_TABLE);
            self.write_link_table(j, SERIES_TABLE);
        }
    }

    fn create_stats_tables(&mut self) {
        let m = self.m;
        if m.nodes[1..].iter().any(|n| n.rpt) {
            self.create_table_hdr(NODE, STATS_TABLE);
            for j in 1..=m.nobjects[NODE] {
                if m.nodes[j].rpt {
                    self.write_node_table(j, STATS_TABLE);
                }
            }
        }
        if m.links[1..].iter().any(|l| l.rpt) {
            self.create_table_hdr(LINK, STATS_TABLE);
            for j in 1..=m.nobjects[LINK] {
                if m.links[j].rpt {
                    self.write_link_table(j, STATS_TABLE);
                }
            }
        }
    }

    fn create_table_hdr(&mut self, kind: usize, table: i32) {
        let m = self.m;
        if table == SERIES_TABLE {
            self.hdr[0] = if kind == NODE {
                format!("<<< Node {} >>>", self.id_name)
            } else {
                format!("<<< Link {} >>>", self.id_name)
            };
            self.hdr[1] = "Time   ".to_string();
            self.hdr[2] = "hr:min ".to_string();
            self.hdr[3] = "-------".to_string();
        } else {
            self.hdr[0] = String::new();
            // As in the C code, the heading is indexed by the table type, not the statistic.
            self.hdr[1] = cfmt::l(STATS_HDRS[table as usize], 16);
            self.hdr[2] = if kind == NODE {
                "for Node        ".to_string()
            } else {
                "for Link        ".to_string()
            };
            self.hdr[3] = "----------------".to_string();
        }
        for sp in 1..=m.nsp() {
            let s = &m.species[sp];
            if !s.rpt || (kind == NODE && s.kind == WALL) {
                continue;
            }
            self.hdr[1].push_str(&format!("  {:>10}", s.id));
            self.hdr[3].push_str("  ----------");
            self.hdr[2].push_str(&format!("  {:>10}", m.species_units(sp)));
        }
        if m.page_size > 0 && i64::from(m.page_size) - self.line_num < 8 {
            self.new_page();
        } else {
            self.write_table_hdr();
        }
    }

    fn write_table_hdr(&mut self) {
        if self.m.page_size > 0 && i64::from(self.m.page_size) - self.line_num < 6 {
            self.new_page();
        }
        let h = self.hdr.clone();
        self.write_line("");
        self.write_line(&h[0]);
        self.write_line("");
        self.write_line(&h[1]);
        self.write_line(&h[2]);
        self.write_line(&h[3]);
    }

    fn hrs_mins(&self, k: usize) -> (i64, i64) {
        let mut mins = (self.m.rstart + k as i64 * self.m.rstep) / 60;
        let h = mins / 60;
        mins -= 60 * h;
        (h, mins)
    }

    fn value(c: f32, precision: i32) -> String {
        let prec = usize::try_from(precision).unwrap_or(6);
        cfmt::r(&cfmt::f(f64::from(c), prec), 10)
    }

    fn write_node_table(&mut self, j: usize, table: i32) {
        let m = self.m;
        for k in 0..self.q.nperiods.max(0) as usize {
            let mut line = if table == SERIES_TABLE {
                let (h, mm) = self.hrs_mins(k);
                format!("{h:4}:{mm:02}")
            } else {
                cfmt::l(&m.node_ids[j - 1], 16)
            };
            for sp in 1..=m.nsp() {
                let s = &m.species[sp];
                if !s.rpt || s.kind == WALL {
                    continue;
                }
                let c = self.out.node_qual(m, k, j, sp);
                line.push_str("  ");
                line.push_str(&Self::value(c, s.precision));
            }
            self.write_line(&line);
        }
    }

    fn write_link_table(&mut self, j: usize, table: i32) {
        let m = self.m;
        for k in 0..self.q.nperiods.max(0) as usize {
            let mut line = if table == SERIES_TABLE {
                let (h, mm) = self.hrs_mins(k);
                format!("{h:4}:{mm:02}")
            } else {
                cfmt::l(&m.link_ids[j - 1], 16)
            };
            for sp in 1..=m.nsp() {
                let s = &m.species[sp];
                if !s.rpt {
                    continue;
                }
                let c = self.out.link_qual(m, k, j, sp);
                line.push_str("  ");
                line.push_str(&Self::value(c, s.precision));
            }
            self.write_line(&line);
        }
    }

    fn write_mass_balance(&mut self) {
        let m = self.m;
        let mb = &self.q.mass;
        for sp in 1..=m.nsp() {
            let s = &m.species[sp];
            if s.pipe_expr_type != RATE {
                continue;
            }
            let e = |v: f64| cfmt::r(&cfmt::e(v, 5), 12);
            let lines = [
                "\n".to_string(),
                format!("Water Quality Mass Balance: {} ({})", s.id, s.units),
                "================================".to_string(),
                format!("Initial Mass:      {}", e(mb.initial[sp])),
                format!(
                    "Mass Inflow:       {}",
                    e(mb.inflow[sp] + mb.indisperse[sp])
                ),
                format!("Mass Outflow:      {}", e(mb.outflow[sp])),
                format!("Mass Reacted:      {}", e(mb.reacted[sp])),
                format!("Final Mass:        {}", e(mb.final_[sp])),
                format!("Mass Ratio:         {}", cfmt::f(mb.ratio[sp], 5)),
                "================================\n".to_string(),
            ];
            for l in lines {
                self.write_line(&l);
            }
        }
    }
}
