// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5, Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! The network as EPANET's legacy toolkit hands it to an extension such as EPANET-MSX:
//! the single-precision values `ENgetnodevalue`, `ENgetlinkvalue` and `ENgetoption`
//! return, and the time parameters of `ENgettimeparam`. Keeping the `f32` rounding
//! here lets a port of the extension see exactly what the original sees.

use crate::Hydraulics;
use crate::quality::MixModel;
use crate::types::{Field, Formula, LinkType, VISCOS};

/// A tank or reservoir (`ENgetnodevalue` on a node after the junctions).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolkitTank {
    /// Solver node index (1-based).
    pub node: usize,
    /// `ENgetnodetype` is `EN_RESERVOIR`.
    pub reservoir: bool,
    /// `EN_INITVOLUME` in user units.
    pub init_volume: f32,
    /// `EN_MIXMODEL`: 0 mixed, 1 two-compartment, 2 FIFO, 3 LIFO.
    pub mix_model: f32,
    /// `EN_MIXZONEVOL` in user units.
    pub mix_zone_volume: f32,
}

/// A link (`ENgetlinknodes`, `ENgetlinkvalue`).
#[derive(Clone, Debug, PartialEq)]
pub struct ToolkitLink {
    pub n1: usize,
    pub n2: usize,
    /// `EN_DIAMETER` in user units (0 for pumps).
    pub diameter: f32,
    /// `EN_LENGTH` in user units.
    pub length: f32,
    /// `EN_ROUGHNESS` in user units (0 for pumps and valves).
    pub roughness: f32,
}

/// What an extension reads from the EPANET project before it runs.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolkitData {
    /// `ENgetflowunits`: EPANET's flow-unit code (0 CFS ... 9 CMD, 10 CMS).
    pub flow_units: i32,
    /// `ENgettimeparam` values, in seconds.
    pub duration: i64,
    pub quality_step: i64,
    pub report_step: i64,
    pub report_start: i64,
    pub pattern_step: i64,
    pub pattern_start: i64,
    /// `EN_STATISTIC`: 0 series, 1 average, 2 minimum, 3 maximum, 4 range.
    pub statistic: i32,
    /// `ENgetoption(EN_SP_VISCOS)`: viscosity relative to water at 20 C.
    pub relative_viscosity: f32,
    /// Node IDs in solver order (junctions first).
    pub node_ids: Vec<String>,
    pub link_ids: Vec<String>,
    pub junctions: usize,
    /// Tanks and reservoirs in solver order.
    pub tanks: Vec<ToolkitTank>,
    pub links: Vec<ToolkitLink>,
}

impl Hydraulics {
    /// The network as EPANET's legacy toolkit getters would report it now.
    pub fn toolkit_data(&self) -> ToolkitData {
        let pr = &self.pr;
        let net = &pr.net;
        let ucf = &pr.units.ucf;
        let tanks = (1..=net.ntanks)
            .map(|j| {
                let t = &net.tank[j];
                ToolkitTank {
                    node: t.node,
                    reservoir: t.a == 0.0,
                    init_volume: (t.v0 * ucf[Field::Volume as usize]) as f32,
                    mix_model: match t.mix_model {
                        MixModel::Mix1 => 0.0,
                        MixModel::Mix2 => 1.0,
                        MixModel::Fifo => 2.0,
                        MixModel::Lifo => 3.0,
                    },
                    mix_zone_volume: (t.v1frac * t.vmax * ucf[Field::Volume as usize]) as f32,
                }
            })
            .collect();
        let links = (1..=net.nlinks)
            .map(|k| {
                let l = &net.link[k];
                let diameter = if l.link_type == LinkType::Pump {
                    0.0
                } else {
                    l.diam * ucf[Field::Diam as usize]
                };
                let roughness = if l.link_type <= LinkType::Pipe {
                    if pr.hyd.formflag == Formula::Dw {
                        l.kc * (1000.0 * ucf[Field::Elev as usize])
                    } else {
                        l.kc
                    }
                } else {
                    0.0
                };
                ToolkitLink {
                    n1: l.n1,
                    n2: l.n2,
                    diameter: diameter as f32,
                    length: (l.len * ucf[Field::Elev as usize]) as f32,
                    roughness: roughness as f32,
                }
            })
            .collect();
        ToolkitData {
            flow_units: pr.units.flowflag as i32,
            duration: pr.times.dur,
            quality_step: pr.times.qstep,
            report_step: pr.times.rstep,
            report_start: pr.times.rstart,
            pattern_step: pr.times.pstep,
            pattern_start: pr.times.pstart,
            statistic: pr.rpt.tstatflag as i32,
            relative_viscosity: (pr.hyd.viscos / VISCOS) as f32,
            node_ids: net.node[1..].iter().map(|n| n.id.clone()).collect(),
            link_ids: net.link[1..].iter().map(|l| l.id.clone()).collect(),
            junctions: net.njuncs,
            tanks,
            links,
        }
    }

    /// The hydraulic solutions recorded since [`Hydraulics::record_for_quality`], as
    /// EPANET's hydraulics file holds them.
    pub fn records(&self) -> Option<&[crate::HydRecord]> {
        self.records.as_deref()
    }
}
