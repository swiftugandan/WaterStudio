// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (leakage.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! FAVAD pipe leakage, modelled as a pair of equivalent emitters at each end
//! junction (`leakage.c`).

use crate::Project;
use crate::types::*;

/// `openleakage`
pub fn openleakage(pr: &mut Project) {
    let net = &pr.net;
    let has = (1..=net.nlinks).any(|i| {
        let l = &net.link[i];
        l.link_type <= LinkType::Pipe && (l.leak_area > 0.0 || l.leak_expan > 0.0)
    });
    pr.hyd.has_leakage = has;
    pr.hyd.leakage = Vec::new();
    if !has {
        return;
    }
    pr.hyd.leakage = vec![Leakage::default(); net.njuncs + 1];
    // convert_pipe_to_node_leakage
    let c_orif = 4.8149766 * 1.0e-6;
    for i in 1..=net.nlinks {
        let link = &net.link[i];
        if link.link_type > LinkType::Pipe {
            continue;
        }
        let j1 = net.node[link.n1].node_type == NodeType::Junction;
        let j2 = net.node[link.n2].node_type == NodeType::Junction;
        if !j1 && !j2 {
            continue;
        }
        if link.leak_area == 0.0 && link.leak_expan == 0.0 {
            continue;
        }
        let mut c_area = c_orif * link.leak_area / (M_PER_FT * M_PER_FT);
        let mut c_expan = c_orif * link.leak_expan / M_PER_FT;
        let mut len = link.len / 100.0;
        if j1 && j2 {
            len *= 0.5;
        }
        c_area *= len;
        c_expan *= len;
        if j1 {
            pr.hyd.leakage[link.n1].cfa += c_area;
            pr.hyd.leakage[link.n1].cva += c_expan;
        }
        if j2 {
            pr.hyd.leakage[link.n2].cfa += c_area;
            pr.hyd.leakage[link.n2].cva += c_expan;
        }
    }
    // init_node_leakage
    for lk in pr.hyd.leakage.iter_mut().skip(1) {
        let c_area = lk.cfa;
        lk.cfa = if c_area > 0.0 {
            1.0 / (c_area * c_area)
        } else {
            0.0
        };
        let c_expan = lk.cva;
        lk.cva = if c_expan > 0.0 {
            1.0 / pow(c_expan, 2.0 / 3.0)
        } else {
            0.0
        };
        if lk.cfa > 0.0 {
            lk.qfa = 0.001;
        }
        if lk.cva > 0.0 {
            lk.qva = 0.001;
        }
    }
}

/// `leakagecoeffs`
pub fn leakagecoeffs(pr: &mut Project) {
    for i in 1..=pr.net.njuncs {
        let Some((hfa, gfa, hva, gva)) = leakage_headloss(pr, i) else {
            continue;
        };
        let row = pr.sm.row[i];
        let el = pr.net.node[i].el;
        if gfa > 0.0 {
            pr.sm.aii[row] += 1.0 / gfa;
            pr.sm.f[row] += (hfa + el) / gfa;
        }
        if gva > 0.0 {
            pr.sm.aii[row] += 1.0 / gva;
            pr.sm.f[row] += (hva + el) / gva;
        }
        pr.hyd.xflow[i] -= pr.hyd.leakage[i].qfa + pr.hyd.leakage[i].qva;
    }
}

/// `leakageflowchange`
pub fn leakageflowchange(pr: &mut Project, i: usize) -> f64 {
    let Some((hfa, gfa, hva, gva)) = leakage_headloss(pr, i) else {
        return 0.0;
    };
    let h = pr.hyd.node_head[i] - pr.net.node[i].el;
    let relax = pr.hyd.relax_factor;
    let mut dqfa = 0.0;
    if gfa > 0.0 {
        dqfa = (hfa - h) / gfa * relax;
        pr.hyd.leakage[i].qfa -= dqfa;
    }
    let mut dqva = 0.0;
    if gva > 0.0 {
        dqva = (hva - h) / gva * relax;
        pr.hyd.leakage[i].qva -= dqva;
    }
    pr.hyd.leakage_flow[i] = pr.hyd.leakage[i].qfa + pr.hyd.leakage[i].qva;
    dqfa + dqva
}

/// `leakagehasconverged`
pub fn leakagehasconverged(pr: &Project) -> bool {
    const QTOL: f64 = 0.0001;
    for i in 1..=pr.net.njuncs {
        let lk = &pr.hyd.leakage[i];
        if lk.cfa == 0.0 && lk.cva == 0.0 {
            continue;
        }
        let h = pr.hyd.node_head[i] - pr.net.node[i].el;
        let mut qref = 0.0;
        if h > 0.0 {
            if lk.cfa > 0.0 {
                qref = sqrt(h / lk.cfa);
            }
            if lk.cva > 0.0 {
                qref += pow(h / lk.cva, 1.5);
            }
        }
        let qtest = lk.qfa + lk.qva;
        if (qref - qtest).abs() > QTOL {
            return false;
        }
    }
    true
}

fn leakage_headloss(pr: &Project, i: usize) -> Option<(f64, f64, f64, f64)> {
    let lk = &pr.hyd.leakage[i];
    if lk.cfa == 0.0 && lk.cva == 0.0 {
        return None;
    }
    let (hfa, gfa) = if lk.cfa == 0.0 {
        (0.0, 0.0)
    } else {
        eval_leak_headloss(lk.qfa, lk.cfa, 0.5)
    };
    let (hva, gva) = if lk.cva == 0.0 {
        (0.0, 0.0)
    } else {
        eval_leak_headloss(lk.qva, lk.cva, 1.5)
    };
    Some((hfa, gfa, hva, gva))
}

fn eval_leak_headloss(q: f64, c: f64, n: f64) -> (f64, f64) {
    let n = 1.0 / n;
    let mut hgrad = n * c * pow(q.abs(), n - 1.0);
    let mut hloss = hgrad * q / n;
    crate::coeffs::addlowerbarrier(q, &mut hloss, &mut hgrad);
    (hloss, hgrad)
}

/// `findlinkleakage`: leakage from a pipe at the current heads (for reporting).
pub fn findlinkleakage(pr: &Project, i: usize) -> f64 {
    let net = &pr.net;
    let link = &net.link[i];
    if link.link_type > LinkType::Pipe {
        return 0.0;
    }
    if link.leak_area == 0.0 && link.leak_expan == 0.0 {
        return 0.0;
    }
    let (n1, n2) = (link.n1, link.n2);
    if n1 > net.njuncs && n2 > net.njuncs {
        return 0.0;
    }
    let h1 = (pr.hyd.node_head[n1] - net.node[n1].el).max(0.0);
    let h2 = (pr.hyd.node_head[n2] - net.node[n2].el).max(0.0);
    let a = link.leak_area / (M_PER_FT * M_PER_FT);
    let m = link.leak_expan / M_PER_FT;
    let len = link.len / 100.0;
    let c = 4.8149766 * (len / 2.0) * 1.0e-6;
    let mut q1 = 0.0;
    if n1 <= net.njuncs {
        q1 = c * (a + m * h1) * sqrt(h1);
    }
    let mut q2 = 0.0;
    if n2 <= net.njuncs {
        q2 = c * (a + m * h2) * sqrt(h2);
    }
    if n2 > net.njuncs {
        q1 *= 2.0;
    }
    if n1 > net.njuncs {
        q2 *= 2.0;
    }
    q1 + q2
}
