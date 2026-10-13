//! A model kept up to date by patches: the engine's resident copy of a document that
//! changes a little at a time (ADR 0020).
//!
//! The document addresses elements by slot (its table row), which never changes while
//! the element lives and comes back with it on undo; the model's order is slot order.
//! A [`Snapshot`] opens a mirror; each [`ModelPatch`] then carries only the slots and
//! sections that changed between two revisions of the same document (`epoch`).

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::{Control, Curve, KeywordSection, Label, Link, Model, Node, Pattern, RawSection, Rule};

/// A whole model with the slot of each element: what opens a mirror.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export_to = "model.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Which document this is a copy of; a patch from another document is refused.
    pub epoch: u32,
    /// The document's revision.
    pub rev: u32,
    pub model: Model,
    /// The slot of each of `model.nodes`, in increasing order.
    pub node_slots: Vec<u32>,
    /// The slot of each of `model.links`, in increasing order.
    pub link_slots: Vec<u32>,
}

/// What changed between two revisions of a document.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export_to = "model.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ModelPatch {
    pub epoch: u32,
    /// The revision the mirror must be at.
    pub from: u32,
    /// The revision it is at afterwards.
    pub to: u32,
    pub nodes: Vec<NodeSlot>,
    pub links: Vec<LinkSlot>,
    /// Sections that changed, each replaced whole.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub title: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub patterns: Option<Vec<Pattern>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub curves: Option<Vec<Curve>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub controls: Option<Vec<Control>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub rules: Option<Vec<Rule>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub options: Option<KeywordSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub times: Option<KeywordSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub report: Option<KeywordSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub energy: Option<KeywordSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub reactions: Option<KeywordSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub backdrop: Option<KeywordSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub labels: Option<Vec<Label>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub extra_sections: Option<Vec<RawSection>>,
}

/// A node slot's new content; `None` empties it (the element was deleted).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export_to = "model.ts"))]
#[serde(rename_all = "camelCase")]
pub struct NodeSlot {
    pub slot: u32,
    pub node: Option<Node>,
}

/// A link slot's new content; `None` empties it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS), ts(export_to = "model.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LinkSlot {
    pub slot: u32,
    pub link: Option<Link>,
}

/// Why a mirror refused a patch or a request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MirrorError {
    /// The patch or request is for another document or revision than the mirror's:
    /// the sender must open it again from a snapshot.
    Stale { have: (u32, u32), want: (u32, u32) },
    /// The snapshot's slot lists do not match its elements.
    Malformed(String),
}

impl std::fmt::Display for MirrorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // The engine client recognises this prefix and resends a snapshot.
            MirrorError::Stale { have, want } => write!(
                f,
                "stale session: the engine holds document {} at revision {}, not {} at {}",
                have.0, have.1, want.0, want.1
            ),
            MirrorError::Malformed(m) => write!(f, "malformed snapshot: {m}"),
        }
    }
}

impl std::error::Error for MirrorError {}

/// A model held with each element's slot and patched in place. A change to an element
/// replaces it where it is; an element added or deleted is put in or taken out at its
/// slot's position, so the model is always in slot order and is never rebuilt.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mirror {
    epoch: u32,
    rev: u32,
    model: Model,
    /// The slot of each of `model.nodes`, increasing.
    node_slots: Vec<u32>,
    /// The slot of each of `model.links`, increasing.
    link_slots: Vec<u32>,
}

/// Put `value` (or nothing) at `slot` in a list kept in slot order.
fn place<T>(items: &mut Vec<T>, slots: &mut Vec<u32>, slot: u32, value: Option<T>) {
    match (slots.binary_search(&slot), value) {
        (Ok(i), Some(v)) => items[i] = v,
        (Ok(i), None) => {
            items.remove(i);
            slots.remove(i);
        }
        (Err(i), Some(v)) => {
            items.insert(i, v);
            slots.insert(i, slot);
        }
        (Err(_), None) => {}
    }
}

impl Mirror {
    /// A mirror holding a snapshot.
    pub fn open(s: Snapshot) -> Result<Self, MirrorError> {
        let Snapshot {
            epoch,
            rev,
            model,
            node_slots,
            link_slots,
        } = s;
        if node_slots.len() != model.nodes.len() || link_slots.len() != model.links.len() {
            return Err(MirrorError::Malformed(format!(
                "{} nodes with {} slots, {} links with {} slots",
                model.nodes.len(),
                node_slots.len(),
                model.links.len(),
                link_slots.len()
            )));
        }
        let increasing = |s: &[u32]| s.windows(2).all(|w| w[0] < w[1]);
        if !increasing(&node_slots) || !increasing(&link_slots) {
            return Err(MirrorError::Malformed("slots out of order".into()));
        }
        Ok(Mirror {
            epoch,
            rev,
            model,
            node_slots,
            link_slots,
        })
    }

    /// The document and revision the mirror holds.
    pub fn version(&self) -> (u32, u32) {
        (self.epoch, self.rev)
    }

    /// Refuse a request for another document or revision.
    pub fn expect(&self, epoch: u32, rev: u32) -> Result<(), MirrorError> {
        if (epoch, rev) == self.version() {
            Ok(())
        } else {
            Err(MirrorError::Stale {
                have: self.version(),
                want: (epoch, rev),
            })
        }
    }

    /// Apply a patch made from the mirror's revision.
    pub fn apply(&mut self, p: ModelPatch) -> Result<(), MirrorError> {
        self.expect(p.epoch, p.from)?;
        let m = &mut self.model;
        for s in p.nodes {
            place(&mut m.nodes, &mut self.node_slots, s.slot, s.node);
        }
        for s in p.links {
            place(&mut m.links, &mut self.link_slots, s.slot, s.link);
        }
        macro_rules! replace {
            ($($f:ident),*) => {$(if let Some(v) = p.$f { m.$f = v; })*};
        }
        replace!(
            title,
            patterns,
            curves,
            controls,
            rules,
            options,
            times,
            report,
            energy,
            reactions,
            backdrop,
            labels,
            extra_sections
        );
        self.rev = p.to;
        Ok(())
    }

    /// The model as it stands, elements in slot order.
    pub fn model(&self) -> &Model {
        &self.model
    }

    /// A snapshot that opens an identical mirror (to carry it to a new engine instance).
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            epoch: self.epoch,
            rev: self.rev,
            model: self.model.clone(),
            node_slots: self.node_slots.clone(),
            link_slots: self.link_slots.clone(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::{Junction, LinkKind, NodeKind, Pipe, PipeStatus};

    fn junction(id: &str, elevation: f64) -> Node {
        Node {
            id: id.into(),
            kind: NodeKind::Junction(Junction {
                elevation,
                ..Junction::default()
            }),
            comment: None,
            tag: None,
            coordinates: None,
            initial_quality: None,
            source: None,
        }
    }

    fn pipe(id: &str, from: &str, to: &str) -> Link {
        Link {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            kind: LinkKind::Pipe(Pipe {
                length: 100.0,
                diameter: 12.0,
                roughness: 100.0,
                minor_loss: 0.0,
                status: PipeStatus::Open,
                leakage: None,
                bulk_coeff: None,
                wall_coeff: None,
            }),
            comment: None,
            tag: None,
            vertices: Vec::new(),
        }
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            epoch: 7,
            rev: 3,
            model: Model {
                nodes: vec![junction("A", 1.0), junction("B", 2.0), junction("C", 3.0)],
                links: vec![pipe("P", "A", "B")],
                ..Model::default()
            },
            // Slot 1 was deleted before the snapshot.
            node_slots: vec![0, 2, 3],
            link_slots: vec![0],
        }
    }

    #[test]
    fn a_snapshot_round_trips() {
        let s = snapshot();
        let m = Mirror::open(s.clone()).unwrap();
        assert_eq!(m.snapshot(), s);
        assert_eq!(m.model(), &s.model);
    }

    #[test]
    fn patches_change_add_delete_and_revive_in_slot_order() {
        let mut m = Mirror::open(snapshot()).unwrap();
        m.apply(ModelPatch {
            epoch: 7,
            from: 3,
            to: 4,
            nodes: vec![
                NodeSlot {
                    slot: 1,
                    node: Some(junction("Back", 9.0)),
                },
                NodeSlot {
                    slot: 2,
                    node: None,
                },
                NodeSlot {
                    slot: 5,
                    node: Some(junction("New", 5.0)),
                },
            ],
            links: vec![LinkSlot {
                slot: 0,
                link: Some(pipe("P", "A", "Back")),
            }],
            title: Some(vec!["Renamed".into()]),
            ..ModelPatch::default()
        })
        .unwrap();
        let model = m.model().clone();
        let ids: Vec<&str> = model.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["A", "Back", "C", "New"]);
        assert_eq!(model.links[0].to, "Back");
        assert_eq!(model.title, ["Renamed"]);
        assert_eq!(m.version(), (7, 4));
    }

    #[test]
    fn a_patch_for_another_revision_or_document_is_stale() {
        let mut m = Mirror::open(snapshot()).unwrap();
        let p = ModelPatch {
            epoch: 7,
            from: 2,
            to: 4,
            ..ModelPatch::default()
        };
        let e = m.apply(p).unwrap_err();
        assert!(e.to_string().starts_with("stale session"));
        assert!(m.expect(8, 3).is_err());
        assert!(m.expect(7, 3).is_ok());
    }

    #[test]
    fn a_snapshot_with_mismatched_slots_is_refused() {
        let mut s = snapshot();
        s.node_slots.pop();
        assert!(matches!(Mirror::open(s), Err(MirrorError::Malformed(_))));
    }
}
