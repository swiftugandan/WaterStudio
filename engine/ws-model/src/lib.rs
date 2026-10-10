//! The canonical network model.
//!
//! It holds everything an EPANET 2.3 input file can express, in the units the user
//! wrote, so that a model read from a file and written back solves identically in
//! EPANET. Network objects (nodes, links, patterns, curves) are typed, because the
//! editor works on them. Settings sections whose keywords EPANET interprets loosely
//! ([OPTIONS], [TIMES], [REPORT], and the global lines of [ENERGY] and [REACTIONS])
//! are kept as ordered keyword lines, exactly as written.
//!
//! Per-element lines of other sections ([DEMANDS], [STATUS], [EMITTERS], [LEAKAGE],
//! [QUALITY], [SOURCES], [REACTIONS], [MIXING], [ENERGY] pump lines, [TAGS],
//! [COORDINATES], [VERTICES]) are folded into the element they describe; ranges are
//! resolved the way EPANET resolves them.

use serde::{Deserialize, Serialize};

pub type Id = String;

/// A whole network model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Model {
    /// [TITLE] lines. EPANET reads the first three.
    pub title: Vec<String>,
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    pub patterns: Vec<Pattern>,
    pub curves: Vec<Curve>,
    pub controls: Vec<Control>,
    pub rules: Vec<Rule>,
    pub options: KeywordSection,
    pub times: KeywordSection,
    pub report: KeywordSection,
    /// Global [ENERGY] lines (GLOBAL ..., DEMAND CHARGE). Pump lines live on pumps.
    pub energy: KeywordSection,
    /// Global [REACTIONS] lines (ORDER, GLOBAL, LIMITING, ROUGHNESS). Element lines live on elements.
    pub reactions: KeywordSection,
    pub backdrop: KeywordSection,
    pub labels: Vec<Label>,
    /// Sections EPANET does not know, kept verbatim with their header.
    pub extra_sections: Vec<RawSection>,
}

/// An ordered list of keyword lines, kept exactly as tokenised.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct KeywordSection {
    pub lines: Vec<KeywordLine>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct KeywordLine {
    pub tokens: Vec<String>,
    pub comment: Option<String>,
}

impl KeywordSection {
    /// The value tokens of the last line whose leading keywords match `keys`
    /// (case-insensitive, EPANET's prefix matching), e.g. `get(&["UNITS"])`.
    pub fn get(&self, keys: &[&str]) -> Option<&[String]> {
        self.lines.iter().rev().find_map(|line| {
            if line.tokens.len() < keys.len() {
                return None;
            }
            let matched = keys
                .iter()
                .zip(&line.tokens)
                .all(|(k, t)| keyword_matches(t, k));
            matched.then(|| &line.tokens[keys.len()..])
        })
    }
}

/// EPANET's keyword match: case-insensitive, and the token need only begin with the keyword.
pub fn keyword_matches(token: &str, keyword: &str) -> bool {
    let token = token.trim_start_matches(' ');
    token.len() >= keyword.len()
        && token
            .chars()
            .zip(keyword.chars())
            .all(|(a, b)| a.eq_ignore_ascii_case(&b))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RawSection {
    pub header: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub id: Id,
    pub kind: NodeKind,
    /// EPANET's description: the comment on the element's line.
    pub comment: Option<String>,
    pub tag: Option<String>,
    pub coordinates: Option<(f64, f64)>,
    /// Initial water quality from [QUALITY].
    pub initial_quality: Option<f64>,
    pub source: Option<Source>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum NodeKind {
    Junction(Junction),
    Reservoir(Reservoir),
    Tank(Tank),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Junction {
    pub elevation: f64,
    /// Demand categories. EPANET always gives a junction at least one.
    pub demands: Vec<Demand>,
    /// Emitter coefficient from [EMITTERS].
    pub emitter: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Demand {
    pub base: f64,
    pub pattern: Option<Id>,
    /// Category name (the comment on a [DEMANDS] line).
    pub category: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Reservoir {
    /// Head, which is also the node's elevation (EPANET reports pressure relative to it).
    pub head: f64,
    pub pattern: Option<Id>,
    /// A level above `head` that EPANET adds to the fixed head. Only a tank line with
    /// zero diameter produces it (EPANET makes such a tank a reservoir whose head is
    /// elevation + initial level); it is 0 for every ordinary reservoir.
    pub level: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Tank {
    pub elevation: f64,
    pub init_level: f64,
    pub min_level: f64,
    pub max_level: f64,
    pub diameter: f64,
    pub min_volume: f64,
    pub volume_curve: Option<Id>,
    /// The ninth column: `Some(true)` for YES, `Some(false)` for NO.
    pub overflow: Option<bool>,
    pub mixing: Option<Mixing>,
    /// Tank bulk reaction coefficient from [REACTIONS] TANK.
    pub bulk_coeff: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mixing {
    pub model: MixModel,
    /// Mixing-zone volume fraction (2COMP only; EPANET uses 1 otherwise).
    pub fraction: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MixModel {
    Mixed,
    TwoComp,
    Fifo,
    Lifo,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub kind: SourceKind,
    pub strength: f64,
    pub pattern: Option<Id>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceKind {
    Concen,
    Mass,
    Setpoint,
    FlowPaced,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Link {
    pub id: Id,
    pub from: Id,
    pub to: Id,
    pub kind: LinkKind,
    pub comment: Option<String>,
    pub tag: Option<String>,
    pub vertices: Vec<(f64, f64)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LinkKind {
    Pipe(Pipe),
    Pump(Pump),
    Valve(Valve),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pipe {
    pub length: f64,
    pub diameter: f64,
    pub roughness: f64,
    pub minor_loss: f64,
    pub status: PipeStatus,
    /// FAVAD leakage from [LEAKAGE]: (area coefficient, expansion coefficient).
    pub leakage: Option<(f64, f64)>,
    pub bulk_coeff: Option<f64>,
    pub wall_coeff: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PipeStatus {
    Open,
    Closed,
    CheckValve,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pump {
    pub curve: Option<PumpCurve>,
    /// Relative speed (EPANET's initial setting).
    pub speed: f64,
    pub pattern: Option<Id>,
    pub status: OpenClosed,
    pub price: Option<f64>,
    pub price_pattern: Option<Id>,
    pub efficiency_curve: Option<Id>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum PumpCurve {
    Head(Id),
    Power(f64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum OpenClosed {
    Open,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Valve {
    pub valve_type: ValveType,
    pub diameter: f64,
    pub setting: ValveSetting,
    pub minor_loss: f64,
    /// Position-loss curve of a PCV (EPANET 2.3).
    pub pcv_curve: Option<Id>,
    /// A fixed status from [STATUS]; `None` means the valve controls (ACTIVE).
    pub fixed_status: Option<OpenClosed>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValveType {
    Prv,
    Psv,
    Pbv,
    Fcv,
    Tcv,
    Gpv,
    Pcv,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum ValveSetting {
    Value(f64),
    /// A GPV's headloss curve.
    Curve(Id),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pattern {
    pub id: Id,
    pub comment: Option<String>,
    pub multipliers: Vec<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Curve {
    pub id: Id,
    pub comment: Option<String>,
    /// The type keyword written on the curve's lines, if any (EPANET 2.3).
    pub kind: Option<CurveKind>,
    pub points: Vec<(f64, f64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CurveKind {
    Volume,
    Pump,
    Efficiency,
    Headloss,
    Generic,
    Valve,
}

/// A simple control, kept as its tokens (parsed into meaning by the engine).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Control {
    pub tokens: Vec<String>,
    pub comment: Option<String>,
}

/// A rule-based control, kept as the text of its lines.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub name: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Label {
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub anchor: Option<Id>,
}

impl Model {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn link(&self, id: &str) -> Option<&Link> {
        self.links.iter().find(|l| l.id == id)
    }
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn keywords_match_by_prefix_ignoring_case() {
        assert!(keyword_matches("units", "UNITS"));
        assert!(keyword_matches("UNITSX", "UNITS"));
        assert!(!keyword_matches("UNIT", "UNITS"));
    }

    #[test]
    fn keyword_section_returns_the_last_match() {
        let s = KeywordSection {
            lines: vec![
                KeywordLine {
                    tokens: vec!["Units".into(), "GPM".into()],
                    comment: None,
                },
                KeywordLine {
                    tokens: vec!["UNITS".into(), "LPS".into()],
                    comment: None,
                },
            ],
        };
        assert_eq!(s.get(&["UNITS"]), Some(&["LPS".to_string()][..]));
        assert_eq!(s.get(&["HEADLOSS"]), None);
    }
}
