// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (epanet.c, rules.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! The toolkit's network structure functions: adding and deleting nodes and links,
//! changing a link's end nodes or type. Like EPANET's, they move the network's arrays
//! and every index into them (tanks, links, pumps, valves, controls, rules) but leave
//! the hydraulic results where they were, to be reset by the next `EN_initH`.

use super::set::{namevalid, valvecheck};
use super::*;
use crate::types::{Demand, Energy, Link, Node, Pump, Tank, Valve};

const EN_UNCONDITIONAL: i32 = 0;
const EN_CONDITIONAL: i32 = 1;

impl Open {
    fn structure_locked(&self) -> bool {
        self.open_h || self.open_q
    }
}

impl Toolkit {
    /// `EN_addnode`
    pub fn addnode(&mut self, id: &str, node_type: i32, index: &mut i32) -> i32 {
        *index = 0;
        let Some(o) = self.o() else { return 102 };
        if o.structure_locked() {
            return 262;
        }
        if !namevalid(id) {
            return 252;
        }
        if Self::findnode(o, id) > 0 {
            return 215;
        }
        if !(EN_JUNCTION..=EN_TANK).contains(&node_type) {
            return 251;
        }
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        let net = &mut pr.net;
        // The hydraulic arrays grow at their end (realloc), unshifted.
        let hyd = &mut pr.hyd;
        for v in [
            &mut hyd.node_demand,
            &mut hyd.node_head,
            &mut hyd.full_demand,
            &mut hyd.emitter_flow,
            &mut hyd.leakage_flow,
            &mut hyd.demand_flow,
            &mut pr.qual.node_qual,
        ] {
            v.push(0.0);
        }
        let node = Node {
            id: id.to_string(),
            el: 0.0,
            d: Vec::new(),
            c0: 0.0,
            ke: 0.0,
            node_type: match node_type {
                EN_JUNCTION => NodeType::Junction,
                EN_RESERVOIR => NodeType::Reservoir,
                _ => NodeType::Tank,
            },
            source: None,
        };
        let n_idx;
        if node_type == EN_JUNCTION {
            net.njuncs += 1;
            n_idx = net.njuncs;
            let mut node = node;
            node.d.push(Demand { base: 0.0, pat: 0 });
            net.node.insert(n_idx, node);
            for i in 1..=net.ntanks {
                net.tank[i].node += 1;
            }
            let nj = net.njuncs;
            for i in 1..=net.nlinks {
                if net.link[i].n1 > nj - 1 {
                    net.link[i].n1 += 1;
                }
                if net.link[i].n2 > nj - 1 {
                    net.link[i].n2 += 1;
                }
            }
            for i in 1..=net.ncontrols {
                if net.control[i].node > nj - 1 {
                    net.control[i].node += 1;
                }
            }
            // adjusttankrules, after Njuncs has grown.
            for r in &mut pr.rules {
                r.shift_tank_premises(nj, 1);
            }
            o.meta.demand_name.insert(n_idx, vec![None]);
        } else {
            n_idx = net.nnodes + 1;
            net.node.insert(n_idx, node);
            net.ntanks += 1;
            net.tank.truncate(net.ntanks);
            net.tank.push(Tank {
                node: n_idx,
                a: if node_type == EN_TANK { 1.0 } else { 0.0 },
                v1frac: 1.0,
                ..Tank::default()
            });
            o.meta.demand_name.insert(n_idx, Vec::new());
        }
        net.nnodes += 1;
        o.meta.node_comment.insert(n_idx, None);
        o.meta.node_tag.insert(n_idx, None);
        o.meta.node_xy.insert(n_idx, None);
        o.meta.node_result.insert(n_idx, 0);
        insert_at(&mut pr.rpt.node_rpt, n_idx, false);
        insert_at(&mut pr.node_order, n_idx, usize::MAX);
        *index = n_idx as i32;
        0
    }

    /// `EN_deletenode`
    pub fn deletenode(&mut self, index: i32, action_code: i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if o.structure_locked() {
            return 262;
        }
        let net = &o.pr.net;
        if index <= 0 || index as usize > net.nnodes {
            return 203;
        }
        if !(EN_UNCONDITIONAL..=EN_CONDITIONAL).contains(&action_code) {
            return 251;
        }
        let i = index as usize;
        if i == o.pr.qual.trace_node {
            return 260;
        }
        if action_code == EN_CONDITIONAL {
            if Self::incontrols(&o.pr, true, i) {
                return 261;
            }
            if (1..=net.nlinks).any(|k| net.link[k].n1 == i || net.link[k].n2 == i) {
                return 259;
            }
        }
        let is_junction = i <= net.njuncs;
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        pr.net.node.remove(i);
        o.meta.node_comment.remove(i);
        o.meta.node_tag.remove(i);
        o.meta.node_xy.remove(i);
        o.meta.demand_name.remove(i);
        o.meta.node_result.remove(i);
        remove_at(&mut pr.rpt.node_rpt, i);
        remove_at(&mut pr.node_order, i);
        if i < pr.qual.trace_node {
            pr.qual.trace_node -= 1;
        }
        let net = &mut pr.net;
        if !is_junction && let Some(t) = (1..=net.ntanks).find(|&t| net.tank[t].node == i) {
            net.tank.remove(t);
        }
        for t in 1..net.tank.len() {
            if net.tank[t].node > i {
                net.tank[t].node -= 1;
            }
        }
        // Links to the deleted node, in reverse to keep their indices.
        let links: Vec<usize> = (1..=net.nlinks)
            .rev()
            .filter(|&k| net.link[k].n1 == i || net.link[k].n2 == i)
            .collect();
        for k in links {
            self.deletelink(k as i32, EN_UNCONDITIONAL);
        }
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        let net = &mut pr.net;
        for k in 1..=net.nlinks {
            if net.link[k].n1 > i {
                net.link[k].n1 -= 1;
            }
            if net.link[k].n2 > i {
                net.link[k].n2 -= 1;
            }
        }
        for c in (1..=net.ncontrols).rev() {
            if net.control[c].node == i {
                net.control.remove(c);
                net.ncontrols -= 1;
            }
        }
        for c in 1..=net.ncontrols {
            if net.control[c].node > i {
                net.control[c].node -= 1;
            }
        }
        crate::rules::adjustrules(&mut pr.rules, true, i);
        if is_junction {
            net.njuncs -= 1;
        } else {
            net.ntanks -= 1;
        }
        net.nnodes -= 1;
        0
    }

    /// `EN_addlink`
    pub fn addlink(
        &mut self,
        id: &str,
        link_type: i32,
        from_node: &str,
        to_node: &str,
        index: &mut i32,
    ) -> i32 {
        *index = 0;
        let Some(o) = self.o() else { return 102 };
        if o.structure_locked() {
            return 262;
        }
        if !namevalid(id) {
            return 252;
        }
        if Self::findlink(o, id) > 0 {
            return 215;
        }
        let Some(lt) = super::set::link_type(link_type) else {
            return 251;
        };
        let n1 = Self::findnode(o, from_node);
        let n2 = Self::findnode(o, to_node);
        if n1 == 0 || n2 == 0 {
            return 203;
        }
        if lt > LinkType::Pump {
            let e = valvecheck(&o.pr.net, 0, lt, n1, n2);
            if e != 0 {
                return e;
            }
        }
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        let net = &mut pr.net;
        net.nlinks += 1;
        let n = net.nlinks;
        pr.hyd.link_flow.push(0.0);
        pr.hyd.link_setting.push(0.0);
        pr.hyd.link_status.push(Status::XHead);
        let diam_ucf = pr.units.ucf[Field::Diam as usize];
        let mut link = Link {
            id: id.to_string(),
            n1,
            n2,
            diam: 0.0,
            len: 0.0,
            kc: 0.0,
            km: 0.0,
            kb: 0.0,
            kw: 0.0,
            r: 0.0,
            leak_area: 0.0,
            leak_expan: 0.0,
            link_type: lt,
            init_status: Status::Open,
            init_setting: 0.0,
            rc: 0.0,
        };
        if lt == LinkType::Pump {
            net.npumps += 1;
            net.pump.truncate(net.npumps);
            net.pump.push(Pump {
                link: n,
                ptype: PumpType::NoCurve,
                q0: 0.0,
                qmax: 0.0,
                hmax: 0.0,
                h0: 0.0,
                r: 0.0,
                n: 0.0,
                hcurve: 0,
                ecurve: 0,
                upat: 0,
                epat: 0,
                ecost: 0.0,
                energy: Energy {
                    total_cost: MISSING,
                    ..Energy::default()
                },
            });
            link.kc = 1.0;
        } else if lt <= LinkType::Pipe {
            link.diam = 10.0 / diam_ucf;
            link.kc = match pr.hyd.formflag {
                Formula::Hw => 130.0,
                Formula::Dw => 0.0005,
                Formula::Cm => 0.01,
            };
            link.len = 330.0;
        } else {
            net.nvalves += 1;
            net.valve.truncate(net.nvalves);
            net.valve.push(Valve { link: n, curve: 0 });
            link.diam = 10.0 / diam_ucf;
            link.init_status = Status::Active;
        }
        link.init_setting = link.kc;
        net.link.truncate(n);
        net.link.push(link);
        o.meta.link_comment.push(None);
        o.meta.link_tag.push(None);
        o.meta.link_vertices.push(Vec::new());
        o.meta.link_result.push(0);
        insert_at(&mut pr.rpt.link_rpt, n, false);
        *index = n as i32;
        0
    }

    /// `EN_deletelink`
    pub fn deletelink(&mut self, index: i32, action_code: i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if o.structure_locked() {
            return 262;
        }
        if index <= 0 || index as usize > o.pr.net.nlinks {
            return 204;
        }
        if !(EN_UNCONDITIONAL..=EN_CONDITIONAL).contains(&action_code) {
            return 251;
        }
        let i = index as usize;
        if action_code == EN_CONDITIONAL && Self::incontrols(&o.pr, false, i) {
            return 261;
        }
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        let net = &mut pr.net;
        let lt = net.link[i].link_type;
        net.link.remove(i);
        o.meta.link_comment.remove(i);
        o.meta.link_tag.remove(i);
        o.meta.link_vertices.remove(i);
        o.meta.link_result.remove(i);
        remove_at(&mut pr.rpt.link_rpt, i);
        // EPANET shifts the pumps' and valves' links first, then looks for the
        // deleted link's pump or valve.
        for p in 1..=net.npumps {
            if net.pump[p].link > i {
                net.pump[p].link -= 1;
            }
        }
        for v in 1..=net.nvalves {
            if net.valve[v].link > i {
                net.valve[v].link -= 1;
            }
        }
        if lt == LinkType::Pump {
            let p = net.findpump(i);
            if p > 0 {
                net.pump.remove(p);
                net.npumps -= 1;
            }
        }
        if lt > LinkType::Pump {
            let v = net.findvalve(i);
            if v > 0 {
                net.valve.remove(v);
                net.nvalves -= 1;
            }
        }
        for c in (1..=net.ncontrols).rev() {
            if net.control[c].link == i {
                net.control.remove(c);
                net.ncontrols -= 1;
            }
        }
        for c in 1..=net.ncontrols {
            if net.control[c].link > i {
                net.control[c].link -= 1;
            }
        }
        crate::rules::adjustrules(&mut pr.rules, false, i);
        net.nlinks -= 1;
        0
    }

    /// `EN_setlinknodes`
    pub fn setlinknodes(&mut self, index: i32, node1: i32, node2: i32) -> i32 {
        let Some(o) = self.om() else { return 204 };
        if o.structure_locked() {
            return 262;
        }
        let net = &mut o.pr.net;
        if index <= 0 || index as usize > net.nlinks {
            return 204;
        }
        if node1 < 0 || node1 as usize > net.nnodes || node2 < 0 || node2 as usize > net.nnodes {
            return 203;
        }
        if node1 == node2 {
            return 222;
        }
        let (n1, n2) = (node1 as usize, node2 as usize);
        let i = index as usize;
        if n1 == net.link[i].n1 && n2 == net.link[i].n2 {
            return 0;
        }
        let lt = net.link[i].link_type;
        if lt > LinkType::Pump {
            let e = valvecheck(net, i, lt, n1, n2);
            if e != 0 {
                return e;
            }
        }
        net.link[i].n1 = n1;
        net.link[i].n2 = n2;
        0
    }

    /// `EN_setlinktype`: a pipe gains or loses its check valve in place; any other change
    /// deletes the link and adds one of the new type with the same ID and end nodes.
    pub fn setlinktype(&mut self, index: &mut i32, link_type: i32, action_code: i32) -> i32 {
        let Some(o) = self.o() else { return 102 };
        if o.structure_locked() {
            return 262;
        }
        let Some(lt) = super::set::link_type(link_type) else {
            return 251;
        };
        if !(EN_UNCONDITIONAL..=EN_CONDITIONAL).contains(&action_code) {
            return 251;
        }
        let i = *index;
        if i <= 0 || i as usize > o.pr.net.nlinks {
            return 204;
        }
        let k = i as usize;
        let old = o.pr.net.link[k].link_type;
        if old == lt {
            return 0;
        }
        let mut action = action_code;
        if action == EN_CONDITIONAL {
            action = i32::from(Self::incontrols(&o.pr, false, k));
            if action > 0 {
                return 261;
            }
        }
        if old <= LinkType::Pipe && lt <= LinkType::Pipe {
            let Some(o) = self.om() else { return 102 };
            o.pr.net.link[k].link_type = lt;
            if lt == LinkType::CvPipe {
                o.pr.net.link[k].init_status = Status::Open;
            }
            return 0;
        }
        let link = &o.pr.net.link[k];
        let (n1, n2) = (link.n1, link.n2);
        let id = link.id.clone();
        let id1 = o.pr.net.node[n1].id.clone();
        let id2 = o.pr.net.node[n2].id.clone();
        let e = valvecheck(&o.pr.net, k, lt, n1, n2);
        if e != 0 {
            return e;
        }
        self.deletelink(i, action);
        self.addlink(&id, link_type, &id1, &id2, index)
    }
}

/// Insert into a 1-based array that may be shorter than the network (left as is then).
fn insert_at<T>(v: &mut Vec<T>, i: usize, x: T) {
    if i <= v.len() {
        v.insert(i, x);
    }
}

fn remove_at<T>(v: &mut Vec<T>, i: usize) {
    if i < v.len() {
        v.remove(i);
    }
}
