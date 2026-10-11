// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (hydsolver.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! Todini's Global Gradient Algorithm (`hydsolver.c`).

use crate::Project;
use crate::coeffs::{demandheadloss, emitterheadloss, headlosscoeffs, matrixcoeffs};
use crate::leakage::{leakageflowchange, leakagehasconverged};
use crate::smatrix::linsolve;
use crate::status::{linkstatus, valvestatus};
use crate::types::*;

#[derive(Default)]
struct Hydbalance {
    maxheaderror: f64,
    maxflowchange: f64,
}

/// `hydsolve`: solve the network equations at the current time. Returns the
/// number of trials and the relative flow change, or EPANET error 110 for an
/// ill-conditioned system.
pub fn hydsolve(pr: &mut Project) -> Result<(i32, f64), (i32, f64, i32)> {
    let mut nextcheck = pr.hyd.check_freq;
    pr.hyd.relax_factor = 1.0;
    let mut hydbal = Hydbalance::default();
    pr.hyd.deficient_nodes = 0;
    pr.hyd.demand_reduction = 0.0;
    let mut maxtrials = pr.hyd.max_iter;
    if pr.hyd.extra_iter > 0 {
        maxtrials += pr.hyd.extra_iter;
    }
    let mut iter = 1;
    let mut relerr = 0.0;
    let mut errcode = 0usize;
    while iter <= maxtrials {
        headlosscoeffs(pr);
        matrixcoeffs(pr);
        errcode = linsolve(&mut pr.sm, pr.net.njuncs);
        if errcode > 0 {
            let node = pr.sm.order[errcode];
            if badvalve(pr, node) {
                continue;
            } else {
                break;
            }
        }
        for i in 1..=pr.net.njuncs {
            pr.hyd.node_head[i] = pr.sm.f[pr.sm.row[i]];
        }
        let newerr = newflows(pr, &mut hydbal);
        relerr = newerr;

        pr.hyd.relax_factor = 1.0;
        let mut valve_change = false;
        if pr.hyd.damp_limit > 0.0 {
            if relerr <= pr.hyd.damp_limit {
                pr.hyd.relax_factor = 0.6;
                valve_change = valvestatus(pr);
            }
        } else {
            valve_change = valvestatus(pr);
        }

        if hasconverged(pr, relerr, &mut hydbal) {
            if iter > pr.hyd.max_iter {
                break;
            }
            let mut stat_change = valve_change;
            if linkstatus(pr) {
                stat_change = true;
            }
            if pswitch(pr) {
                stat_change = true;
            }
            if !stat_change {
                break;
            }
            nextcheck = iter + pr.hyd.check_freq;
        } else if iter <= pr.hyd.max_check && iter == nextcheck {
            linkstatus(pr);
            nextcheck += pr.hyd.check_freq;
        }
        iter += 1;
    }

    for i in 1..=pr.net.njuncs {
        pr.hyd.node_demand[i] =
            pr.hyd.demand_flow[i] + pr.hyd.emitter_flow[i] + pr.hyd.leakage_flow[i];
    }
    pr.hyd.relative_error = relerr;
    pr.hyd.max_head_error = hydbal.maxheaderror;
    pr.hyd.max_flow_change = hydbal.maxflowchange;
    pr.hyd.iterations = iter;
    if errcode > 0 {
        return Err((110, relerr, pr.sm.order[errcode] as i32));
    }
    Ok((iter, relerr))
}

/// `badvalve`: if node `n` is the end of an active PRV, PSV or FCV, fix its
/// status so the solution can continue.
fn badvalve(pr: &mut Project, n: usize) -> bool {
    for i in 1..=pr.net.nvalves {
        let k = pr.net.valve[i].link;
        let (n1, n2) = (pr.net.link[k].n1, pr.net.link[k].n2);
        if n == n1 || n == n2 {
            let t = pr.net.link[k].link_type;
            if (t == LinkType::Prv || t == LinkType::Psv || t == LinkType::Fcv)
                && pr.hyd.link_status[k] == Status::Active
            {
                pr.hyd.link_status[k] = if t == LinkType::Fcv {
                    Status::XFcv
                } else {
                    Status::XPressure
                };
                return true;
            }
            return false;
        }
    }
    false
}

/// `pswitch`: apply simple controls on junction pressure.
fn pswitch(pr: &mut Project) -> bool {
    let mut anychange = false;
    for i in 1..=pr.net.ncontrols {
        let c = pr.net.control[i].clone();
        let k = c.link;
        if k == 0 {
            continue;
        }
        let n = c.node;
        let mut reset = false;
        if n > 0 && n <= pr.net.njuncs {
            if c.control_type == ControlType::LowLevel
                && pr.hyd.node_head[n] <= c.grade + pr.hyd.htol
            {
                reset = true;
            }
            if c.control_type == ControlType::HiLevel
                && pr.hyd.node_head[n] >= c.grade - pr.hyd.htol
            {
                reset = true;
            }
        }
        if reset {
            let lt = pr.net.link[k].link_type;
            let s = pr.hyd.link_status[k];
            let mut change = false;
            if lt == LinkType::Pipe && s != c.status {
                change = true;
            }
            if lt == LinkType::Pump && pr.hyd.link_setting[k] != c.setting {
                change = true;
            }
            if lt >= LinkType::Prv {
                if pr.hyd.link_setting[k] != c.setting {
                    change = true;
                } else if pr.hyd.link_setting[k] == MISSING && s != c.status {
                    change = true;
                }
            }
            if change {
                pr.hyd.link_status[k] = c.status;
                if lt > LinkType::Pipe {
                    pr.hyd.link_setting[k] = c.setting;
                }
                anychange = true;
            }
        }
    }
    anychange
}

fn newflows(pr: &mut Project, hbal: &mut Hydbalance) -> f64 {
    let mut qsum = 0.0;
    let mut dqsum = 0.0;
    hbal.maxflowchange = 0.0;
    newlinkflows(pr, hbal, &mut qsum, &mut dqsum);
    newemitterflows(pr, hbal, &mut qsum, &mut dqsum);
    newdemandflows(pr, hbal, &mut qsum, &mut dqsum);
    if pr.hyd.has_leakage {
        newleakageflows(pr, hbal, &mut qsum, &mut dqsum);
    }
    if qsum > pr.hyd.hacc {
        dqsum / qsum
    } else {
        dqsum
    }
}

fn newlinkflows(pr: &mut Project, hbal: &mut Hydbalance, qsum: &mut f64, dqsum: &mut f64) {
    let njuncs = pr.net.njuncs;
    for n in njuncs + 1..=pr.net.nnodes {
        pr.hyd.node_demand[n] = 0.0;
    }
    for k in 1..=pr.net.nlinks {
        let (n1, n2) = (pr.net.link[k].n1, pr.net.link[k].n2);
        let dh = pr.hyd.node_head[n1] - pr.hyd.node_head[n2];
        let mut dq = pr.hyd.y[k] - pr.hyd.p[k] * dh;
        dq *= pr.hyd.relax_factor;
        if pr.net.link[k].link_type == LinkType::Pump {
            let n = pr.net.findpump(k);
            if pr.net.pump[n].ptype == PumpType::ConstHp && dq > pr.hyd.link_flow[k] {
                dq = pr.hyd.link_flow[k] / 2.0;
            }
        }
        pr.hyd.link_flow[k] -= dq;
        *qsum += pr.hyd.link_flow[k].abs();
        *dqsum += dq.abs();
        if dq.abs() > hbal.maxflowchange {
            hbal.maxflowchange = dq.abs();
        }
        if pr.hyd.link_status[k] > Status::Closed {
            if n1 > njuncs {
                pr.hyd.node_demand[n1] -= pr.hyd.link_flow[k];
            }
            if n2 > njuncs {
                pr.hyd.node_demand[n2] += pr.hyd.link_flow[k];
            }
        }
    }
}

fn newemitterflows(pr: &mut Project, hbal: &mut Hydbalance, qsum: &mut f64, dqsum: &mut f64) {
    for i in 1..=pr.net.njuncs {
        if pr.net.node[i].ke == 0.0 {
            continue;
        }
        let (hloss, hgrad) = emitterheadloss(pr, i);
        let dh = pr.hyd.node_head[i] - pr.net.node[i].el;
        let mut dq = (hloss - dh) / hgrad;
        dq *= pr.hyd.relax_factor;
        pr.hyd.emitter_flow[i] -= dq;
        *qsum += pr.hyd.emitter_flow[i].abs();
        *dqsum += dq.abs();
        if dq.abs() > hbal.maxflowchange {
            hbal.maxflowchange = dq.abs();
        }
    }
}

fn newleakageflows(pr: &mut Project, hbal: &mut Hydbalance, qsum: &mut f64, dqsum: &mut f64) {
    for i in 1..=pr.net.njuncs {
        let dq = leakageflowchange(pr, i);
        if dq == 0.0 {
            continue;
        }
        *qsum += pr.hyd.leakage_flow[i].abs();
        *dqsum += dq.abs();
        if dq.abs() > hbal.maxflowchange {
            hbal.maxflowchange = dq.abs();
        }
    }
}

fn newdemandflows(pr: &mut Project, hbal: &mut Hydbalance, qsum: &mut f64, dqsum: &mut f64) {
    if pr.hyd.demand_model == DemandModel::Dda {
        return;
    }
    let dp = (pr.hyd.preq - pr.hyd.pmin).max(MINPDIFF);
    let n = 1.0 / pr.hyd.pexp;
    for i in 1..=pr.net.njuncs {
        if pr.hyd.full_demand[i] <= 0.0 {
            continue;
        }
        let (hloss, hgrad) = demandheadloss(pr, i, dp, n);
        let dh = pr.hyd.node_head[i] - pr.net.node[i].el - pr.hyd.pmin;
        let mut dq = (hloss - dh) / hgrad;
        dq *= pr.hyd.relax_factor;
        if dq.abs() > 0.4 * pr.hyd.full_demand[i] {
            dq = 0.4 * sgn(dq) * pr.hyd.full_demand[i];
        }
        pr.hyd.demand_flow[i] -= dq;
        *qsum += pr.hyd.demand_flow[i].abs();
        *dqsum += dq.abs();
        if dq.abs() > hbal.maxflowchange {
            hbal.maxflowchange = dq.abs();
        }
    }
}

fn checkhydbalance(pr: &mut Project, hbal: &mut Hydbalance) {
    hbal.maxheaderror = 0.0;
    headlosscoeffs(pr);
    for k in 1..=pr.net.nlinks {
        if pr.hyd.link_status[k] <= Status::Closed || pr.hyd.p[k] == 0.0 {
            continue;
        }
        let (n1, n2) = (pr.net.link[k].n1, pr.net.link[k].n2);
        let dh = pr.hyd.node_head[n1] - pr.hyd.node_head[n2];
        let headloss = pr.hyd.y[k] / pr.hyd.p[k];
        let headerror = (dh - headloss).abs();
        if headerror > hbal.maxheaderror {
            hbal.maxheaderror = headerror;
        }
    }
}

fn hasconverged(pr: &mut Project, relerr: f64, hbal: &mut Hydbalance) -> bool {
    if relerr > pr.hyd.hacc {
        return false;
    }
    checkhydbalance(pr, hbal);
    if pr.hyd.head_error_limit > 0.0 && hbal.maxheaderror > pr.hyd.head_error_limit {
        return false;
    }
    if pr.hyd.flow_change_limit > 0.0 && hbal.maxflowchange > pr.hyd.flow_change_limit {
        return false;
    }
    if pr.hyd.has_leakage && !leakagehasconverged(pr) {
        return false;
    }
    if pr.hyd.demand_model == DemandModel::Pda {
        return pdaconverged(pr);
    }
    true
}

fn pdaconverged(pr: &mut Project) -> bool {
    const QTOL: f64 = 0.0001;
    let mut converged = true;
    let mut total_demand = 0.0;
    let mut total_reduction = 0.0;
    let dp = pr.hyd.preq - pr.hyd.pmin;
    pr.hyd.deficient_nodes = 0;
    pr.hyd.demand_reduction = 0.0;
    for i in 1..=pr.net.njuncs {
        let full = pr.hyd.full_demand[i];
        if full <= 0.0 {
            continue;
        }
        let p = pr.hyd.node_head[i] - pr.net.node[i].el;
        let q = if p <= pr.hyd.pmin {
            0.0
        } else if p >= pr.hyd.preq {
            full
        } else {
            let r = (p - pr.hyd.pmin) / dp;
            full * pow(r, pr.hyd.pexp)
        };
        if (q - pr.hyd.demand_flow[i]).abs() > QTOL {
            converged = false;
        }
        if pr.hyd.demand_flow[i] + QTOL < full {
            pr.hyd.deficient_nodes += 1;
            total_demand += full;
            total_reduction += full - pr.hyd.demand_flow[i];
        }
    }
    if total_demand > 0.0 {
        pr.hyd.demand_reduction = total_reduction / total_demand * 100.0;
    }
    converged
}
