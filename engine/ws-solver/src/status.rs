// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (hydstatus.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! Status updates for valves, pumps, check valves and links to tanks.

use crate::Project;
use crate::types::*;

/// `valvestatus`: PRV and PSV status changes. Returns true if any changed.
pub fn valvestatus(pr: &mut Project) -> bool {
    let mut change = false;
    for i in 1..=pr.net.nvalves {
        let k = pr.net.valve[i].link;
        if pr.hyd.link_setting[k] == MISSING {
            continue;
        }
        let (n1, n2) = (pr.net.link[k].n1, pr.net.link[k].n2);
        let status = pr.hyd.link_status[k];
        let (h1, h2) = (pr.hyd.node_head[n1], pr.hyd.node_head[n2]);
        match pr.net.link[k].link_type {
            LinkType::Prv => {
                let hset = pr.net.node[n2].el + pr.hyd.link_setting[k];
                pr.hyd.link_status[k] = prvstatus(pr, k, status, hset, h1, h2);
            }
            LinkType::Psv => {
                let hset = pr.net.node[n1].el + pr.hyd.link_setting[k];
                pr.hyd.link_status[k] = psvstatus(pr, k, status, hset, h1, h2);
            }
            _ => continue,
        }
        if status != pr.hyd.link_status[k] {
            change = true;
        }
    }
    change
}

/// `linkstatus`: status changes for CVs, pumps, FCVs and links to tanks.
pub fn linkstatus(pr: &mut Project) -> bool {
    let mut change = false;
    let njuncs = pr.net.njuncs;
    for k in 1..=pr.net.nlinks {
        let (n1, n2) = (pr.net.link[k].n1, pr.net.link[k].n2);
        let dh = pr.hyd.node_head[n1] - pr.hyd.node_head[n2];
        let status = pr.hyd.link_status[k];
        if status == Status::XHead || status == Status::TempClosed {
            pr.hyd.link_status[k] = Status::Open;
        }
        let lt = pr.net.link[k].link_type;
        if lt == LinkType::CvPipe {
            pr.hyd.link_status[k] = cvstatus(pr, pr.hyd.link_status[k], dh, pr.hyd.link_flow[k]);
        }
        if lt == LinkType::Pump
            && pr.hyd.link_status[k] >= Status::Open
            && pr.hyd.link_setting[k] > 0.0
        {
            pr.hyd.link_status[k] = pumpstatus(pr, k, -dh);
        }
        if lt == LinkType::Fcv && pr.hyd.link_setting[k] != MISSING {
            pr.hyd.link_status[k] =
                fcvstatus(pr, k, status, pr.hyd.node_head[n1], pr.hyd.node_head[n2]);
        }
        if n1 > njuncs {
            tankstatus(pr, k, n1, pr.hyd.link_flow[k]);
        }
        if n2 > njuncs {
            tankstatus(pr, k, n2, -pr.hyd.link_flow[k]);
        }
        if status != pr.hyd.link_status[k] {
            change = true;
        }
    }
    change
}

fn cvstatus(pr: &Project, s: Status, dh: f64, q: f64) -> Status {
    let (htol, qtol) = (pr.hyd.htol, pr.hyd.qtol);
    if dh.abs() > htol {
        if dh < -htol || q < -qtol {
            Status::Closed
        } else {
            Status::Open
        }
    } else if q < -qtol {
        Status::Closed
    } else {
        s
    }
}

fn pumpstatus(pr: &Project, k: usize, dh: f64) -> Status {
    let p = pr.net.findpump(k);
    let hmax;
    if pr.net.pump[p].ptype == PumpType::ConstHp {
        hmax = BIG;
        if pr.hyd.link_flow[k] < TINY {
            return Status::TempClosed;
        }
    } else {
        let s = pr.hyd.link_setting[k];
        hmax = (s * s) * pr.net.pump[p].hmax;
    }
    if dh > hmax + pr.hyd.htol {
        return Status::XHead;
    }
    Status::Open
}

fn prvstatus(pr: &Project, k: usize, s: Status, hset: f64, h1: f64, h2: f64) -> Status {
    let htol = pr.hyd.htol;
    let q = pr.hyd.link_flow[k];
    let hml = pr.net.link[k].km * (q * q);
    match s {
        Status::Active => {
            if q < -pr.hyd.qtol {
                Status::Closed
            } else if h1 - hml < hset - htol {
                Status::Open
            } else {
                Status::Active
            }
        }
        Status::Open => {
            if q < -pr.hyd.qtol {
                Status::Closed
            } else if h2 >= hset + htol {
                Status::Active
            } else {
                Status::Open
            }
        }
        Status::Closed => {
            if h1 >= hset + htol && h2 < hset - htol {
                Status::Active
            } else if h1 < hset - htol && h1 > h2 + htol {
                Status::Open
            } else {
                Status::Closed
            }
        }
        Status::XPressure => {
            if q < -pr.hyd.qtol {
                Status::Closed
            } else {
                s
            }
        }
        _ => s,
    }
}

fn psvstatus(pr: &Project, k: usize, s: Status, hset: f64, h1: f64, h2: f64) -> Status {
    let htol = pr.hyd.htol;
    let q = pr.hyd.link_flow[k];
    let hml = pr.net.link[k].km * (q * q);
    match s {
        Status::Active => {
            if q < -pr.hyd.qtol {
                Status::Closed
            } else if h2 + hml > hset + htol {
                Status::Open
            } else {
                Status::Active
            }
        }
        Status::Open => {
            if q < -pr.hyd.qtol {
                Status::Closed
            } else if h1 < hset - htol {
                Status::Active
            } else {
                Status::Open
            }
        }
        Status::Closed => {
            if h2 > hset + htol && h1 > h2 + htol {
                Status::Open
            } else if h1 >= hset + htol && h1 > h2 + htol {
                Status::Active
            } else {
                Status::Closed
            }
        }
        Status::XPressure => {
            if q < -pr.hyd.qtol {
                Status::Closed
            } else {
                s
            }
        }
        _ => s,
    }
}

fn fcvstatus(pr: &Project, k: usize, s: Status, h1: f64, h2: f64) -> Status {
    let q = pr.hyd.link_flow[k];
    let mut status = s;
    if h1 - h2 < -pr.hyd.htol || q < -pr.hyd.qtol {
        status = Status::XFcv;
    } else if s == Status::XFcv && q >= pr.hyd.link_setting[k] {
        status = Status::Active;
    } else if status == Status::Active && (h1 - h2) / (q * q) < pr.net.link[k].km {
        status = Status::XFcv;
    }
    status
}

fn tankstatus(pr: &mut Project, k: usize, n: usize, q: f64) {
    if pr.hyd.link_status[k] <= Status::Closed {
        return;
    }
    let i = n - pr.net.njuncs;
    let tank = &pr.net.tank[i];
    if tank.a == 0.0 {
        return;
    }
    let h = pr.hyd.node_head[n];
    if h >= tank.hmax && !tank.can_overflow && q < 0.0 {
        pr.hyd.link_status[k] = Status::TempClosed;
    } else if h <= tank.hmin && q > 0.0 {
        pr.hyd.link_status[k] = Status::TempClosed;
    }
}
