//! The `.inp` writer. Sections come in the order EPANET's own `saveinpfile` uses.
//! EPANET numbers tanks and reservoirs, and links, in file order across sections, so
//! those are written as consecutive runs of one kind (EPANET accepts repeated
//! sections), which keeps every element's index.
//! Every value is written explicitly and exactly (shortest round-trip form), so the
//! file never depends on EPANET's defaults and solves identically to the model.

use std::fmt::Write as _;

use ws_model::{
    CurveKind, KeywordSection, LinkKind, MixModel, Model, NodeKind, OpenClosed, PipeStatus,
    PumpCurve, SourceKind, ValveSetting, ValveType,
};

/// Write the model as `.inp` text.
pub fn write_inp(m: &Model) -> String {
    let mut w = Writer::default();
    w.title(m);
    w.junctions(m);
    w.storage(m);
    w.links(m);
    w.tags(m);
    w.demands(m);
    w.status(m);
    w.patterns(m);
    w.curves(m);
    w.controls(m);
    w.rules(m);
    w.energy(m);
    w.emitters(m);
    w.leakage(m);
    w.quality(m);
    w.sources(m);
    w.reactions(m);
    w.mixing(m);
    w.keyword_section("[TIMES]", &m.times);
    w.keyword_section("[REPORT]", &m.report);
    w.keyword_section("[OPTIONS]", &m.options);
    w.coordinates(m);
    w.vertices(m);
    w.labels(m);
    w.keyword_section("[BACKDROP]", &m.backdrop);
    for s in &m.extra_sections {
        w.out.push_str(&s.header);
        w.out.push('\n');
        for line in &s.lines {
            w.out.push_str(line);
            w.out.push('\n');
        }
        w.out.push('\n');
    }
    w.out.push_str("[END]\n");
    w.out
}

/// A number in its shortest exact form; exponent form for very large or small values.
pub fn num(x: f64) -> String {
    let a = x.abs();
    if x == 0.0 || (1e-4..1e15).contains(&a) {
        format!("{x}")
    } else {
        format!("{x:e}")
    }
}

/// A token as EPANET's tokeniser will read it back.
pub fn tok(s: &str) -> String {
    if s.is_empty() || s.contains([' ', '\t', ';']) {
        format!("\"{s}\"")
    } else {
        s.to_string()
    }
}

#[derive(Default)]
struct Writer {
    out: String,
}

impl Writer {
    fn header(&mut self, name: &str, columns: &str) {
        self.out.push_str(name);
        self.out.push('\n');
        if !columns.is_empty() {
            let _ = writeln!(self.out, ";;{columns}");
        }
    }

    fn row(&mut self, fields: &[String], comment: Option<&str>) {
        self.out.push(' ');
        self.out.push_str(&fields.join("\t"));
        if let Some(c) = comment {
            self.out.push_str("\t;");
            self.out.push_str(c);
        }
        self.out.push('\n');
    }

    fn end(&mut self) {
        self.out.push('\n');
    }

    fn title(&mut self, m: &Model) {
        self.out.push_str("[TITLE]\n");
        for line in &m.title {
            self.out.push_str(line);
            self.out.push('\n');
        }
        self.end();
    }

    fn junctions(&mut self, m: &Model) {
        self.header("[JUNCTIONS]", "ID\tElev\tDemand\tPattern");
        for n in &m.nodes {
            let NodeKind::Junction(j) = &n.kind else {
                continue;
            };
            let mut f = vec![tok(&n.id), num(j.elevation)];
            // One demand without a category goes on the junction line; otherwise all
            // demands go to [DEMANDS], whose first line replaces this one's.
            if let [d] = j.demands.as_slice()
                && d.category.is_none()
            {
                f.push(num(d.base));
                if let Some(p) = &d.pattern {
                    f.push(tok(p));
                }
            }
            self.row(&f, n.comment.as_deref());
        }
        self.end();
    }

    fn storage(&mut self, m: &Model) {
        let mut current: Option<bool> = None; // Some(true) while writing tanks
        for n in &m.nodes {
            // A reservoir with a level offset can only be written as a zero-diameter tank.
            let is_tank = match &n.kind {
                NodeKind::Junction(_) => continue,
                NodeKind::Reservoir(r) => r.level != 0.0,
                NodeKind::Tank(_) => true,
            };
            if current != Some(is_tank) {
                if current.is_some() {
                    self.end();
                }
                if is_tank {
                    self.header(
                        "[TANKS]",
                        "ID\tElevation\tInitLevel\tMinLevel\tMaxLevel\tDiameter\tMinVol\tVolCurve\tOverflow",
                    );
                } else {
                    self.header("[RESERVOIRS]", "ID\tHead\tPattern");
                }
                current = Some(is_tank);
            }
            let f = match &n.kind {
                NodeKind::Reservoir(r) if r.level != 0.0 => {
                    let zero = num(0.0);
                    vec![
                        tok(&n.id),
                        num(r.head),
                        num(r.level),
                        zero.clone(),
                        zero.clone(),
                        zero,
                    ]
                }
                NodeKind::Reservoir(r) => {
                    let mut f = vec![tok(&n.id), num(r.head)];
                    if let Some(p) = &r.pattern {
                        f.push(tok(p));
                    }
                    f
                }
                NodeKind::Tank(t) => {
                    let mut f = vec![
                        tok(&n.id),
                        num(t.elevation),
                        num(t.init_level),
                        num(t.min_level),
                        num(t.max_level),
                        num(t.diameter),
                        num(t.min_volume),
                    ];
                    if t.volume_curve.is_some() || t.overflow.is_some() {
                        f.push(t.volume_curve.as_deref().map_or("*".to_string(), tok));
                    }
                    if let Some(o) = t.overflow {
                        f.push(if o { "YES" } else { "NO" }.to_string());
                    }
                    f
                }
                NodeKind::Junction(_) => continue,
            };
            self.row(&f, n.comment.as_deref());
        }
        if current.is_some() {
            self.end();
        }
    }

    fn links(&mut self, m: &Model) {
        #[derive(PartialEq, Clone, Copy)]
        enum K {
            Pipe,
            Pump,
            Valve,
        }
        let mut current: Option<K> = None;
        for l in &m.links {
            let k = match &l.kind {
                LinkKind::Pipe(_) => K::Pipe,
                LinkKind::Pump(_) => K::Pump,
                LinkKind::Valve(_) => K::Valve,
            };
            if current != Some(k) {
                if current.is_some() {
                    self.end();
                }
                match k {
                    K::Pipe => self.header(
                        "[PIPES]",
                        "ID\tNode1\tNode2\tLength\tDiameter\tRoughness\tMinorLoss\tStatus",
                    ),
                    K::Pump => self.header("[PUMPS]", "ID\tNode1\tNode2\tParameters"),
                    K::Valve => self.header(
                        "[VALVES]",
                        "ID\tNode1\tNode2\tDiameter\tType\tSetting\tMinorLoss",
                    ),
                }
                current = Some(k);
            }
            let mut f = vec![tok(&l.id), tok(&l.from), tok(&l.to)];
            match &l.kind {
                LinkKind::Pipe(p) => {
                    let status = match p.status {
                        PipeStatus::Open => "Open",
                        PipeStatus::Closed => "Closed",
                        PipeStatus::CheckValve => "CV",
                    };
                    f.extend([
                        num(p.length),
                        num(p.diameter),
                        num(p.roughness),
                        num(p.minor_loss),
                        status.to_string(),
                    ]);
                }
                LinkKind::Pump(p) => {
                    match &p.curve {
                        Some(PumpCurve::Head(c)) => f.extend(["HEAD".to_string(), tok(c)]),
                        Some(PumpCurve::Power(w)) => f.extend(["POWER".to_string(), num(*w)]),
                        None => {}
                    }
                    if p.speed != 1.0 {
                        f.extend(["SPEED".to_string(), num(p.speed)]);
                    }
                    if let Some(pat) = &p.pattern {
                        f.extend(["PATTERN".to_string(), tok(pat)]);
                    }
                }
                LinkKind::Valve(v) => {
                    let kind = match v.valve_type {
                        ValveType::Prv => "PRV",
                        ValveType::Psv => "PSV",
                        ValveType::Pbv => "PBV",
                        ValveType::Fcv => "FCV",
                        ValveType::Tcv => "TCV",
                        ValveType::Gpv => "GPV",
                        ValveType::Pcv => "PCV",
                    };
                    f.extend([num(v.diameter), kind.to_string()]);
                    match &v.setting {
                        ValveSetting::Curve(c) => f.push(tok(c)),
                        // A GPV without a curve cannot be written with a setting; EPANET
                        // reads its sixth token as a curve ID.
                        ValveSetting::Value(_) if v.valve_type == ValveType::Gpv => {}
                        ValveSetting::Value(x) => f.push(num(*x)),
                    }
                    if f.len() == 6 {
                        f.push(num(v.minor_loss));
                        if let Some(c) = &v.pcv_curve {
                            f.push(tok(c));
                        }
                    }
                }
            }
            self.row(&f, l.comment.as_deref());
        }
        if current.is_some() {
            self.end();
        }
    }

    fn tags(&mut self, m: &Model) {
        self.header("[TAGS]", "");
        for n in &m.nodes {
            if let Some(t) = &n.tag {
                self.row(&["NODE".into(), tok(&n.id), tok(t)], None);
            }
        }
        for l in &m.links {
            if let Some(t) = &l.tag {
                self.row(&["LINK".into(), tok(&l.id), tok(t)], None);
            }
        }
        self.end();
    }

    fn demands(&mut self, m: &Model) {
        self.header("[DEMANDS]", "Junction\tDemand\tPattern\tCategory");
        for n in &m.nodes {
            let NodeKind::Junction(j) = &n.kind else {
                continue;
            };
            let inline = matches!(j.demands.as_slice(), [d] if d.category.is_none());
            if inline {
                continue;
            }
            for d in &j.demands {
                let mut f = vec![tok(&n.id), num(d.base)];
                if let Some(p) = &d.pattern {
                    f.push(tok(p));
                }
                self.row(&f, d.category.as_deref());
            }
        }
        self.end();
    }

    fn status(&mut self, m: &Model) {
        self.header("[STATUS]", "ID\tStatus/Setting");
        for l in &m.links {
            let s = match &l.kind {
                LinkKind::Pump(p) if p.status == OpenClosed::Closed => Some("Closed"),
                LinkKind::Valve(v) => match v.fixed_status {
                    Some(OpenClosed::Open) => Some("Open"),
                    Some(OpenClosed::Closed) => Some("Closed"),
                    None => None,
                },
                _ => None,
            };
            if let Some(s) = s {
                self.row(&[tok(&l.id), s.to_string()], None);
            }
        }
        self.end();
    }

    fn patterns(&mut self, m: &Model) {
        // No column header here: a comment line just before a pattern becomes its description.
        self.out.push_str("[PATTERNS]\n\n");
        for p in &m.patterns {
            if let Some(c) = &p.comment {
                let _ = writeln!(self.out, ";{c}");
            }
            if p.multipliers.is_empty() {
                self.row(&[tok(&p.id)], None);
            }
            for chunk in p.multipliers.chunks(6) {
                let mut f = vec![tok(&p.id)];
                f.extend(chunk.iter().map(|v| num(*v)));
                self.row(&f, None);
            }
        }
        self.end();
    }

    fn curves(&mut self, m: &Model) {
        self.out.push_str("[CURVES]\n\n");
        for c in &m.curves {
            if let Some(text) = &c.comment {
                let _ = writeln!(self.out, ";{text}");
            }
            for (i, (x, y)) in c.points.iter().enumerate() {
                let mut f = vec![tok(&c.id), num(*x), num(*y)];
                if i == 0
                    && let Some(k) = c.kind
                {
                    f.push(
                        match k {
                            CurveKind::Volume => "VOLUME",
                            CurveKind::Pump => "PUMP",
                            CurveKind::Efficiency => "EFFICIENCY",
                            CurveKind::Headloss => "HEADLOSS",
                            CurveKind::Generic => "GENERIC",
                            CurveKind::Valve => "VALVE",
                        }
                        .to_string(),
                    );
                }
                self.row(&f, None);
            }
        }
        self.end();
    }

    fn controls(&mut self, m: &Model) {
        self.header("[CONTROLS]", "");
        for c in &m.controls {
            let f: Vec<String> = c.tokens.iter().map(|t| tok(t)).collect();
            self.row(&f, c.comment.as_deref());
        }
        self.end();
    }

    fn rules(&mut self, m: &Model) {
        self.out.push_str("[RULES]\n");
        for r in &m.rules {
            for line in &r.lines {
                self.out.push_str(line);
                self.out.push('\n');
            }
            self.out.push('\n');
        }
        self.end();
    }

    fn keyword_lines(&mut self, s: &KeywordSection) {
        for line in &s.lines {
            let f: Vec<String> = line.tokens.iter().map(|t| tok(t)).collect();
            self.row(&f, line.comment.as_deref());
        }
    }

    fn keyword_section(&mut self, name: &str, s: &KeywordSection) {
        self.header(name, "");
        self.keyword_lines(s);
        self.end();
    }

    fn energy(&mut self, m: &Model) {
        self.header("[ENERGY]", "");
        self.keyword_lines(&m.energy);
        for l in &m.links {
            let LinkKind::Pump(p) = &l.kind else { continue };
            let id = tok(&l.id);
            if let Some(c) = &p.efficiency_curve {
                self.row(
                    &["Pump".into(), id.clone(), "Efficiency".into(), tok(c)],
                    None,
                );
            }
            if let Some(price) = p.price {
                self.row(
                    &["Pump".into(), id.clone(), "Price".into(), num(price)],
                    None,
                );
            }
            if let Some(pat) = &p.price_pattern {
                self.row(&["Pump".into(), id, "Pattern".into(), tok(pat)], None);
            }
        }
        self.end();
    }

    fn emitters(&mut self, m: &Model) {
        self.header("[EMITTERS]", "Junction\tCoefficient");
        for n in &m.nodes {
            if let NodeKind::Junction(j) = &n.kind
                && let Some(k) = j.emitter
            {
                self.row(&[tok(&n.id), num(k)], None);
            }
        }
        self.end();
    }

    fn leakage(&mut self, m: &Model) {
        self.header("[LEAKAGE]", "Pipe\tLeak Area\tLeak Expansion");
        for l in &m.links {
            if let LinkKind::Pipe(p) = &l.kind
                && let Some((a, e)) = p.leakage
            {
                self.row(&[tok(&l.id), num(a), num(e)], None);
            }
        }
        self.end();
    }

    fn quality(&mut self, m: &Model) {
        self.header("[QUALITY]", "Node\tInitQual");
        for n in &m.nodes {
            if let Some(q) = n.initial_quality {
                self.row(&[tok(&n.id), num(q)], None);
            }
        }
        self.end();
    }

    fn sources(&mut self, m: &Model) {
        self.header("[SOURCES]", "Node\tType\tQuality\tPattern");
        for n in &m.nodes {
            let Some(s) = &n.source else { continue };
            let kind = match s.kind {
                SourceKind::Concen => "CONCEN",
                SourceKind::Mass => "MASS",
                SourceKind::Setpoint => "SETPOINT",
                SourceKind::FlowPaced => "FLOWPACED",
            };
            let mut f = vec![tok(&n.id), kind.to_string(), num(s.strength)];
            if let Some(p) = &s.pattern {
                f.push(tok(p));
            }
            self.row(&f, None);
        }
        self.end();
    }

    fn reactions(&mut self, m: &Model) {
        self.header("[REACTIONS]", "");
        self.keyword_lines(&m.reactions);
        for l in &m.links {
            if let LinkKind::Pipe(p) = &l.kind {
                if let Some(k) = p.bulk_coeff {
                    self.row(&["Bulk".into(), tok(&l.id), num(k)], None);
                }
                if let Some(k) = p.wall_coeff {
                    self.row(&["Wall".into(), tok(&l.id), num(k)], None);
                }
            }
        }
        for n in &m.nodes {
            if let NodeKind::Tank(t) = &n.kind
                && let Some(k) = t.bulk_coeff
            {
                self.row(&["Tank".into(), tok(&n.id), num(k)], None);
            }
        }
        self.end();
    }

    fn mixing(&mut self, m: &Model) {
        self.header("[MIXING]", "Tank\tModel");
        for n in &m.nodes {
            let NodeKind::Tank(t) = &n.kind else { continue };
            let Some(mix) = &t.mixing else { continue };
            let mut f = vec![tok(&n.id)];
            match mix.model {
                MixModel::Mixed => f.push("MIXED".into()),
                MixModel::TwoComp => f.extend(["2COMP".into(), num(mix.fraction)]),
                MixModel::Fifo => f.push("FIFO".into()),
                MixModel::Lifo => f.push("LIFO".into()),
            }
            self.row(&f, None);
        }
        self.end();
    }

    fn coordinates(&mut self, m: &Model) {
        self.header("[COORDINATES]", "Node\tX-Coord\tY-Coord");
        for n in &m.nodes {
            if let Some((x, y)) = n.coordinates {
                self.row(&[tok(&n.id), num(x), num(y)], None);
            }
        }
        self.end();
    }

    fn vertices(&mut self, m: &Model) {
        self.header("[VERTICES]", "Link\tX-Coord\tY-Coord");
        for l in &m.links {
            for (x, y) in &l.vertices {
                self.row(&[tok(&l.id), num(*x), num(*y)], None);
            }
        }
        self.end();
    }

    fn labels(&mut self, m: &Model) {
        self.header("[LABELS]", "X-Coord\tY-Coord\tLabel & Anchor Node");
        for label in &m.labels {
            let mut f = vec![num(label.x), num(label.y), format!("\"{}\"", label.text)];
            if let Some(a) = &label.anchor {
                f.push(tok(a));
            }
            self.row(&f, None);
        }
        self.end();
    }
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::read_inp;

    #[test]
    fn numbers_round_trip_exactly() {
        for x in [0.0, 1.0, 0.1, 1.0 / 3.0, 1e-7, 123456.789, 2.5e20, -0.0003] {
            assert_eq!(num(x).parse::<f64>().ok(), Some(x), "{x}");
        }
        assert_eq!(num(100.0), "100");
    }

    #[test]
    fn link_and_storage_order_is_kept_with_repeated_sections() {
        let text = "[JUNCTIONS]\n A 0\n B 0\n C 0\n[TANKS]\n T 10 1 0 5 20\n[RESERVOIRS]\n R 50\n\
            [TANKS]\n Z 10 2 0 0 0\n[VALVES]\n V A B 12 TCV 1\n[PIPES]\n P1 B C 10 12 100 0 Open\n\
            [VALVES]\n W C A 12 TCV 1\n";
        let a = read_inp(text);
        let b = read_inp(&write_inp(&a.model));
        let ids = |r: &crate::ReadResult| {
            (
                r.model.nodes.iter().map(|n| n.id.clone()).collect::<Vec<_>>(),
                r.model.links.iter().map(|l| l.id.clone()).collect::<Vec<_>>(),
            )
        };
        assert_eq!(ids(&a), ids(&b));
        assert_eq!(ids(&b).1, ["V", "P1", "W"]);
        assert_eq!(a.model, b.model);
    }

    #[test]
    fn a_model_survives_write_and_read() {
        let text = "[TITLE]\nTwo pipes\n[JUNCTIONS]\n J1 100 1 P ;first\n J2 90\n\
            [RESERVOIRS]\n R 220\n[TANKS]\n T 120 5 1 10 30 0 * YES\n\
            [PIPES]\n P1 R J1 1000 12 100 0 Open\n P2 J1 J2 500 8 100 0.5 CV\n P3 J2 T 100 8 100 0 Closed\n\
            [DEMANDS]\n J2 3 P ;Homes\n J2 4 ;Shops\n\
            [PATTERNS]\n;Daily\n P 1 1.2 0.8\n[CURVES]\n C 0 0 VOLUME\n C 10 100\n\
            [EMITTERS]\n J1 0.5\n[MIXING]\n T 2COMP 0.3\n[QUALITY]\n J1 1\n\
            [OPTIONS]\n Units GPM\n Headloss H-W\n[COORDINATES]\n J1 1 2\n[END]\n";
        let a = read_inp(text);
        assert_eq!(a.errors().count(), 0, "{:?}", a.issues);
        let written = write_inp(&a.model);
        let b = read_inp(&written);
        assert_eq!(b.errors().count(), 0, "{:?}\n{written}", b.issues);
        assert_eq!(a.model, b.model, "\n{written}");
    }
}
