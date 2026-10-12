// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (epanet.c), Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! The toolkit's rule-based control functions.

use std::collections::HashMap;

use super::*;

impl Toolkit {
    fn rule_mut(&mut self, index: i32) -> Option<&mut crate::rules::Rule> {
        let o = self.om()?;
        let i = usize::try_from(index).ok()?.checked_sub(1)?;
        o.pr.rules.get_mut(i)
    }

    fn rule(&self, index: i32) -> Option<&crate::rules::Rule> {
        let o = self.o()?;
        let i = usize::try_from(index).ok()?.checked_sub(1)?;
        o.pr.rules.get(i)
    }

    /// `EN_addrule`
    pub fn addrule(&mut self, rule: &str) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let pr = &mut o.pr;
        let nodes: HashMap<&str, usize> = (1..=pr.net.nnodes)
            .map(|i| (pr.net.node[i].id.as_str(), i))
            .collect();
        let links: HashMap<&str, usize> = (1..=pr.net.nlinks)
            .map(|i| (pr.net.link[i].id.as_str(), i))
            .collect();
        crate::rules::addrule(&pr.net, &mut pr.rules, rule, &nodes, &links)
    }

    /// `EN_deleterule`
    pub fn deleterule(&mut self, index: i32) -> i32 {
        let Some(o) = self.om() else { return 257 };
        let n = o.pr.rules.len();
        if index < 1 || index as usize > n {
            return 257;
        }
        o.pr.rules.remove(index as usize - 1);
        0
    }

    /// `EN_getrule`
    pub fn getrule(
        &self,
        index: i32,
        n_premises: &mut i32,
        n_then: &mut i32,
        n_else: &mut i32,
        priority: &mut f64,
    ) -> i32 {
        let Some(r) = self.rule(index) else {
            return 257;
        };
        *priority = r.priority;
        let (p, t, e) = r.counts();
        *n_premises = p as i32;
        *n_then = t as i32;
        *n_else = e as i32;
        0
    }

    /// `EN_getruleID`
    pub fn getruleid(&self, index: i32, id: &mut String) -> i32 {
        id.clear();
        if !self.is_open() {
            return 102;
        }
        let Some(r) = self.rule(index) else {
            return 257;
        };
        id.push_str(&r.label);
        0
    }

    /// `EN_getpremise`
    #[allow(clippy::too_many_arguments)]
    pub fn getpremise(
        &self,
        rule_index: i32,
        premise_index: i32,
        logop: &mut i32,
        object: &mut i32,
        obj_index: &mut i32,
        variable: &mut i32,
        relop: &mut i32,
        status: &mut i32,
        value: &mut f64,
    ) -> i32 {
        let Some(r) = self.rule(rule_index) else {
            return 257;
        };
        let Some(p) = usize::try_from(premise_index)
            .ok()
            .and_then(|i| r.premise(i))
        else {
            return 258;
        };
        (
            *logop, *object, *obj_index, *variable, *relop, *status, *value,
        ) = p;
        0
    }

    /// `EN_setpremise`
    #[allow(clippy::too_many_arguments)]
    pub fn setpremise(
        &mut self,
        rule_index: i32,
        premise_index: i32,
        logop: i32,
        object: i32,
        obj_index: i32,
        variable: i32,
        relop: i32,
        status: i32,
        value: f64,
    ) -> i32 {
        let Some(r) = self.rule_mut(rule_index) else {
            return 257;
        };
        let i = usize::try_from(premise_index).unwrap_or(0);
        r.set_premise(i, logop, object, obj_index, variable, relop, status, value)
    }

    /// `EN_setpremiseindex`
    pub fn setpremiseindex(&mut self, rule_index: i32, premise_index: i32, obj_index: i32) -> i32 {
        let Some(r) = self.rule_mut(rule_index) else {
            return 257;
        };
        r.set_premise_index(usize::try_from(premise_index).unwrap_or(0), obj_index)
    }

    /// `EN_setpremisestatus`
    pub fn setpremisestatus(&mut self, rule_index: i32, premise_index: i32, status: i32) -> i32 {
        let Some(r) = self.rule_mut(rule_index) else {
            return 257;
        };
        r.set_premise_status(usize::try_from(premise_index).unwrap_or(0), status)
    }

    /// `EN_setpremisevalue`
    pub fn setpremisevalue(&mut self, rule_index: i32, premise_index: i32, value: f64) -> i32 {
        let Some(r) = self.rule_mut(rule_index) else {
            return 257;
        };
        r.set_premise_value(usize::try_from(premise_index).unwrap_or(0), value)
    }

    fn getaction(
        &self,
        then: bool,
        rule_index: i32,
        action_index: i32,
        link_index: &mut i32,
        status: &mut i32,
        setting: &mut f64,
    ) -> i32 {
        let Some(r) = self.rule(rule_index) else {
            return 257;
        };
        let Some(a) = usize::try_from(action_index)
            .ok()
            .and_then(|i| r.action(then, i))
        else {
            return 258;
        };
        (*link_index, *status, *setting) = a;
        0
    }

    /// `EN_getthenaction`
    pub fn getthenaction(
        &self,
        rule_index: i32,
        action_index: i32,
        link_index: &mut i32,
        status: &mut i32,
        setting: &mut f64,
    ) -> i32 {
        self.getaction(true, rule_index, action_index, link_index, status, setting)
    }

    /// `EN_getelseaction`
    pub fn getelseaction(
        &self,
        rule_index: i32,
        action_index: i32,
        link_index: &mut i32,
        status: &mut i32,
        setting: &mut f64,
    ) -> i32 {
        self.getaction(false, rule_index, action_index, link_index, status, setting)
    }

    /// `EN_setthenaction`
    pub fn setthenaction(
        &mut self,
        rule_index: i32,
        action_index: i32,
        link_index: i32,
        status: i32,
        setting: f64,
    ) -> i32 {
        let Some(r) = self.rule_mut(rule_index) else {
            return 257;
        };
        r.set_action(
            true,
            usize::try_from(action_index).unwrap_or(0),
            link_index,
            status,
            setting,
        )
    }

    /// `EN_setelseaction`
    pub fn setelseaction(
        &mut self,
        rule_index: i32,
        action_index: i32,
        link_index: i32,
        status: i32,
        setting: f64,
    ) -> i32 {
        let Some(r) = self.rule_mut(rule_index) else {
            return 257;
        };
        r.set_action(
            false,
            usize::try_from(action_index).unwrap_or(0),
            link_index,
            status,
            setting,
        )
    }

    /// `EN_setrulepriority`
    pub fn setrulepriority(&mut self, index: i32, priority: f64) -> i32 {
        let Some(r) = self.rule_mut(index) else {
            return 257;
        };
        r.priority = priority;
        0
    }

    /// `EN_getruleenabled` (EPANET answers 241 for a rule that does not exist)
    pub fn getruleenabled(&self, index: i32, enabled: &mut i32) -> i32 {
        if !self.is_open() {
            return 102;
        }
        let Some(r) = self.rule(index) else {
            return 241;
        };
        *enabled = i32::from(r.is_enabled);
        0
    }

    /// `EN_setruleenabled`
    pub fn setruleenabled(&mut self, index: i32, enabled: i32) -> i32 {
        if enabled != 0 && enabled != 1 {
            return 202;
        }
        if !self.is_open() {
            return 102;
        }
        let Some(r) = self.rule_mut(index) else {
            return 241;
        };
        r.is_enabled = enabled == 1;
        0
    }
}
