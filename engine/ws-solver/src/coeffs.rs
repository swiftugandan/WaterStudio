// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (hydcoeffs.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! Coefficients of the linearised hydraulic equations (`hydcoeffs.c`).

use crate::Project;
use crate::leakage::leakagecoeffs;
use crate::types::*;

// Constants for the Darcy-Weisbach friction factor.
const A1: f64 = 3.141_592_653_589_793_238_50e+03; // 1000*PI
const A2: f64 = 1.570_796_326_794_896_619_30e+03; // 500*PI
const A8: f64 = 4.618_413_198_590_666_686_90e+00; // 5.74*(PI/4)^.9
const A9: f64 = -8.685_889_638_065_036_553_00e-01; // -2/ln(10)
const AB: f64 = 3.288_954_763_453_990_586_90e-03; // 5.74/(4000^.9)
const AC: f64 = -5.142_149_657_990_938_837_60e-03; // AA*AB

/// `addlowerbarrier`
pub fn addlowerbarrier(dq: f64, hloss: &mut f64, hgrad: &mut f64) {
    let a = 1.0e9 * dq;
    let b = sqrt(a * a + 1.0e-6);
    *hloss += (a - b) / 2.0;
    *hgrad += (1.0e9 / 2.0) * (1.0 - a / b);
}

/// `addupperbarrier`
pub fn addupperbarrier(dq: f64, hloss: &mut f64, hgrad: &mut f64) {
    let a = 1.0e9 * dq;
    let b = sqrt(a * a + 1.0e-6);
    *hloss += (a + b) / 2.0;
    *hgrad += (1.0e9 / 2.0) * (1.0 + a / b);
}

/// `resistcoeff`: a link's flow resistance.
pub fn resistcoeff(pr: &mut Project, k: usize) {
    let hexp = pr.hyd.hexp;
    let formflag = pr.hyd.formflag;
    let lt = pr.net.link[k].link_type;
    let r = match lt {
        LinkType::CvPipe | LinkType::Pipe => {
            let link = &pr.net.link[k];
            let (e, d, l) = (link.kc, link.diam, link.len);
            match formflag {
                Formula::Hw => 4.727 * l / pow(e, hexp) / pow(d, 4.871),
                Formula::Dw => {
                    let a = PI * (d * d) / 4.0;
                    l / 2.0 / 32.2 / d / (a * a)
                }
                Formula::Cm => {
                    let c = 4.0 * e / (1.49 * PI * (d * d));
                    c * c * pow(d / 4.0, -1.333) * l
                }
            }
        }
        LinkType::Pump => CBIG,
        LinkType::Pcv => pcvlosscoeff(pr, k, pr.net.link[k].kc),
        _ => CSMALL,
    };
    pr.net.link[k].r = r;
}

/// `pcvlosscoeff`: loss coefficient of a positional control valve at setting `s`.
pub fn pcvlosscoeff(pr: &Project, k: usize, s: f64) -> f64 {
    let net = &pr.net;
    let v = net.findvalve(k);
    let c = net.valve[v].curve;
    if s == MISSING {
        return 0.0;
    }
    let kmo = net.link[k].km;
    if s >= 100.0 {
        return kmo;
    }
    if s <= 0.0 {
        return CBIG;
    }
    let mut kvr = if c == 0 {
        s
    } else {
        let curve = &net.curve[c];
        let (x, y) = (&curve.x, &curve.y);
        let npts = x.len();
        if s < x[0] {
            s / x[0] * y[0]
        } else if s > x[npts - 1] {
            let k2 = npts - 1;
            (s - x[k2]) / (1.0 - x[k2]) * (1.0 - y[k2]) + y[k2]
        } else {
            let mut k2 = 0;
            while k2 < npts && x[k2] < s {
                k2 += 1;
            }
            if k2 == 0 {
                k2 += 1;
            } else if k2 == npts {
                k2 -= 1;
            }
            let k1 = k2 - 1;
            let slope = (y[k2] - y[k1]) / (x[k2] - x[k1]);
            y[k1] + slope * (s - x[k1])
        }
    };
    kvr /= 100.0;
    kvr = kvr.min(1.0);
    kvr = kvr.max(CSMALL);
    let km = kmo / (kvr * kvr);
    km.min(CBIG)
}

/// `headlosscoeffs`: P and Y coefficients of every link.
pub fn headlosscoeffs(pr: &mut Project) {
    for k in 1..=pr.net.nlinks {
        match pr.net.link[k].link_type {
            LinkType::CvPipe | LinkType::Pipe => pipecoeff(pr, k),
            LinkType::Pump => pumpcoeff(pr, k),
            LinkType::Pbv => pbvcoeff(pr, k),
            LinkType::Tcv => tcvcoeff(pr, k),
            LinkType::Pcv => pcvcoeff(pr, k),
            LinkType::Gpv => gpvcoeff(pr, k),
            LinkType::Fcv | LinkType::Prv | LinkType::Psv => {
                if pr.hyd.link_setting[k] == MISSING {
                    valvecoeff(pr, k);
                } else {
                    pr.hyd.p[k] = 0.0;
                }
            }
        }
    }
}

/// `matrixcoeffs`: assemble the solution matrix and right-hand side.
pub fn matrixcoeffs(pr: &mut Project) {
    let nnodes = pr.net.nnodes;
    pr.sm.aii[..=nnodes].fill(0.0);
    let nc = pr.sm.ncoeffs;
    pr.sm.aij[..=nc].fill(0.0);
    pr.sm.f[..=nnodes].fill(0.0);
    pr.hyd.xflow[..=nnodes].fill(0.0);
    linkcoeffs(pr);
    emittercoeffs(pr);
    demandcoeffs(pr);
    if pr.hyd.has_leakage {
        leakagecoeffs(pr);
    }
    nodecoeffs(pr);
    valvecoeffs(pr);
}

fn linkcoeffs(pr: &mut Project) {
    let njuncs = pr.net.njuncs;
    for k in 1..=pr.net.nlinks {
        let p = pr.hyd.p[k];
        if p == 0.0 {
            continue;
        }
        let n1 = pr.net.link[k].n1;
        let n2 = pr.net.link[k].n2;
        let q = pr.hyd.link_flow[k];
        let y = pr.hyd.y[k];
        pr.hyd.xflow[n1] -= q;
        pr.hyd.xflow[n2] += q;
        let ndx = pr.sm.ndx[k];
        pr.sm.aij[ndx] -= p;
        if n1 <= njuncs {
            let r = pr.sm.row[n1];
            pr.sm.aii[r] += p;
            pr.sm.f[r] += y;
        } else {
            let r = pr.sm.row[n2];
            pr.sm.f[r] += p * pr.hyd.node_head[n1];
        }
        if n2 <= njuncs {
            let r = pr.sm.row[n2];
            pr.sm.aii[r] += p;
            pr.sm.f[r] -= y;
        } else {
            let r = pr.sm.row[n1];
            pr.sm.f[r] += p * pr.hyd.node_head[n2];
        }
    }
}

fn nodecoeffs(pr: &mut Project) {
    for i in 1..=pr.net.njuncs {
        pr.hyd.xflow[i] -= pr.hyd.demand_flow[i];
        let r = pr.sm.row[i];
        pr.sm.f[r] += pr.hyd.xflow[i];
    }
}

fn valvecoeffs(pr: &mut Project) {
    for i in 1..=pr.net.nvalves {
        let k = pr.net.valve[i].link;
        if pr.hyd.link_setting[k] == MISSING {
            continue;
        }
        let n1 = pr.net.link[k].n1;
        let n2 = pr.net.link[k].n2;
        match pr.net.link[k].link_type {
            LinkType::Prv => prvcoeff(pr, k, n1, n2),
            LinkType::Psv => psvcoeff(pr, k, n1, n2),
            LinkType::Fcv => fcvcoeff(pr, k, n1, n2),
            _ => continue,
        }
    }
}

fn emittercoeffs(pr: &mut Project) {
    for i in 1..=pr.net.njuncs {
        if pr.net.node[i].ke == 0.0 {
            continue;
        }
        let (hloss, hgrad) = emitterheadloss(pr, i);
        let row = pr.sm.row[i];
        pr.sm.aii[row] += 1.0 / hgrad;
        pr.sm.f[row] += (hloss + pr.net.node[i].el) / hgrad;
        pr.hyd.xflow[i] -= pr.hyd.emitter_flow[i];
    }
}

/// `emitterheadloss`: head loss and gradient through an emitter.
pub fn emitterheadloss(pr: &Project, i: usize) -> (f64, f64) {
    let hyd = &pr.hyd;
    let ke = CSMALL.max(pr.net.node[i].ke);
    let q = hyd.emitter_flow[i];
    let mut hgrad = hyd.qexp * ke * pow(q.abs(), hyd.qexp - 1.0);
    let mut hloss;
    if hgrad < hyd.rqtol {
        hgrad = hyd.rqtol / hyd.qexp;
        hloss = hgrad * q;
    } else {
        hloss = hgrad * q / hyd.qexp;
    }
    if !hyd.emit_back_flag {
        addlowerbarrier(q, &mut hloss, &mut hgrad);
    }
    (hloss, hgrad)
}

fn demandcoeffs(pr: &mut Project) {
    if pr.hyd.demand_model == DemandModel::Dda {
        return;
    }
    let dp = pr.hyd.preq - pr.hyd.pmin;
    let n = 1.0 / pr.hyd.pexp;
    for i in 1..=pr.net.njuncs {
        if pr.hyd.full_demand[i] <= 0.0 {
            continue;
        }
        let (hloss, hgrad) = demandheadloss(pr, i, dp, n);
        if hgrad > 0.0 {
            let row = pr.sm.row[i];
            pr.sm.aii[row] += 1.0 / hgrad;
            pr.sm.f[row] += (hloss + pr.net.node[i].el + pr.hyd.pmin) / hgrad;
        }
    }
}

/// `demandheadloss`: head loss and gradient of a pressure-dependent demand.
pub fn demandheadloss(pr: &Project, i: usize, dp: f64, n: f64) -> (f64, f64) {
    let d = pr.hyd.demand_flow[i];
    let dfull = pr.hyd.full_demand[i];
    let r = d.abs() / dfull;
    let mut hgrad = n * dp * pow(r, n - 1.0) / dfull;
    let mut hloss = hgrad * d / n;
    addlowerbarrier(d, &mut hloss, &mut hgrad);
    addupperbarrier(d - dfull, &mut hloss, &mut hgrad);
    (hloss, hgrad)
}

fn pipecoeff(pr: &mut Project, k: usize) {
    if pr.hyd.link_status[k] <= Status::Closed {
        pr.hyd.p[k] = 1.0 / CBIG;
        pr.hyd.y[k] = pr.hyd.link_flow[k];
        return;
    }
    if pr.hyd.formflag == Formula::Dw {
        dwpipecoeff(pr, k);
        return;
    }
    let hyd = &pr.hyd;
    let q = hyd.link_flow[k].abs();
    let ml = pr.net.link[k].km;
    let r = pr.net.link[k].r;
    let mut hgrad = hyd.hexp * r * pow(q, hyd.hexp - 1.0);
    let mut hloss;
    if hgrad < hyd.rqtol {
        hgrad = hyd.rqtol / hyd.hexp;
        hloss = hgrad * q;
    } else {
        hloss = hgrad * q / hyd.hexp;
    }
    if ml > 0.0 {
        hloss += ml * q * q;
        hgrad += 2.0 * ml * q;
    }
    hloss *= sgn(hyd.link_flow[k]);
    pr.hyd.p[k] = 1.0 / hgrad;
    pr.hyd.y[k] = hloss / hgrad;
}

fn dwpipecoeff(pr: &mut Project, k: usize) {
    let hyd = &pr.hyd;
    let link = &pr.net.link[k];
    let flow = hyd.link_flow[k];
    let q = flow.abs();
    let mut r = link.r;
    let ml = link.km;
    let e = link.kc / link.diam;
    let s = hyd.viscos * link.diam;
    let (hloss, hgrad);
    if q <= A2 * s {
        r = 16.0 * PI * s * r;
        hloss = flow * (r + ml * q);
        hgrad = r + 2.0 * ml * q;
    } else {
        let (f, dfdq) = friction_factor(q, e, s);
        let r1 = f * r + ml;
        hloss = r1 * q * flow;
        hgrad = (2.0 * r1 * q) + (dfdq * r * q * q);
    }
    pr.hyd.p[k] = 1.0 / hgrad;
    pr.hyd.y[k] = hloss / hgrad;
}

/// `frictionFactor`: Darcy-Weisbach friction factor and its derivative.
fn friction_factor(q: f64, e: f64, s: f64) -> (f64, f64) {
    let w = q / s;
    if w >= A1 {
        let y1 = A8 / pow(w, 0.9);
        let y2 = e / 3.7 + y1;
        let y3 = A9 * log(y2);
        let f = 1.0 / (y3 * y3);
        let dfdq = 1.8 * f * y1 * A9 / y2 / y3 / q;
        (f, dfdq)
    } else {
        let y2 = e / 3.7 + AB;
        let y3 = A9 * log(y2);
        let fa = 1.0 / (y3 * y3);
        let fb = (2.0 + AC / (y2 * y3)) * fa;
        let r = w / A2;
        let x1 = 7.0 * fa - fb;
        let x2 = 0.128 - 17.0 * fa + 2.5 * fb;
        let x3 = -0.128 + 13.0 * fa - (fb + fb);
        let x4 = 0.032 - 3.0 * fa + 0.5 * fb;
        let f = x1 + r * (x2 + r * (x3 + r * x4));
        let dfdq = (x2 + r * (2.0 * x3 + r * 3.0 * x4)) / s / A2;
        (f, dfdq)
    }
}

fn pumpcoeff(pr: &mut Project, k: usize) {
    let setting = pr.hyd.link_setting[k];
    let flow = pr.hyd.link_flow[k];
    if pr.hyd.link_status[k] <= Status::Closed || setting == 0.0 {
        pr.hyd.p[k] = 1.0 / CBIG;
        pr.hyd.y[k] = flow;
        return;
    }
    let q = flow.abs();
    let p = pr.net.findpump(k);
    if pr.net.pump[p].ptype == PumpType::NoCurve {
        pr.hyd.p[k] = 1.0 / CSMALL;
        pr.hyd.y[k] = flow;
        return;
    }
    let (hloss, hgrad);
    if pr.net.pump[p].ptype == PumpType::Custom {
        let (h0, r) = curvecoeff(pr, pr.net.pump[p].hcurve, q / setting);
        let pump = &mut pr.net.pump[p];
        pump.h0 = -h0;
        pump.r = -r;
        pump.n = 1.0;
        hgrad = pump.r * setting;
        hloss = pump.h0 * (setting * setting) + hgrad * flow;
    } else {
        let pump = &pr.net.pump[p];
        let h0 = setting * setting * pump.h0;
        let mut n = pump.n;
        if (n - 1.0).abs() < TINY {
            n = 1.0;
        }
        let r = pump.r * pow(setting, 2.0 - n);
        if pump.ptype == PumpType::ConstHp {
            let g = -r / q / q;
            if g > CBIG {
                pr.hyd.p[k] = 1.0 / CBIG;
                pr.hyd.y[k] = flow;
                return;
            } else if g < CSMALL {
                pr.hyd.p[k] = 1.0 / CSMALL;
                pr.hyd.y[k] = flow;
                return;
            }
            hgrad = g;
            hloss = r / flow;
        } else if n != 1.0 {
            let g = n * r * pow(q, n - 1.0);
            if g < pr.hyd.rqtol {
                hgrad = pr.hyd.rqtol;
                hloss = h0 + hgrad * flow;
            } else {
                hgrad = g;
                hloss = h0 + hgrad * flow / n;
            }
        } else {
            hgrad = r;
            hloss = h0 + hgrad * flow;
        }
    }
    pr.hyd.p[k] = 1.0 / hgrad;
    pr.hyd.y[k] = hloss / hgrad;
}

/// `curvecoeff`: intercept and slope of the curve segment containing `q`
/// (curves are stored in user units).
pub fn curvecoeff(pr: &Project, i: usize, q: f64) -> (f64, f64) {
    let uflow = pr.units.ucf[Field::Flow as usize];
    let uhead = pr.units.ucf[Field::Head as usize];
    let q = q * uflow;
    let curve = &pr.net.curve[i];
    let (x, y) = (&curve.x, &curve.y);
    let npts = x.len();
    let mut k2 = 0;
    while k2 < npts && x[k2] < q {
        k2 += 1;
    }
    if k2 == 0 {
        k2 += 1;
    } else if k2 == npts {
        k2 -= 1;
    }
    let k1 = k2 - 1;
    let r = (y[k2] - y[k1]) / (x[k2] - x[k1]);
    let h0 = y[k1] - r * x[k1];
    (h0 / uhead, r * uflow / uhead)
}

fn gpvcoeff(pr: &mut Project, k: usize) {
    if pr.hyd.link_status[k] == Status::Closed {
        valvecoeff(pr, k);
    } else {
        let i = round(pr.hyd.link_setting[k]) as usize;
        let flow = pr.hyd.link_flow[k];
        let q = flow.abs().max(TINY);
        let (h0, r) = curvecoeff(pr, i, q);
        let r = r.max(TINY);
        pr.hyd.p[k] = 1.0 / r;
        pr.hyd.y[k] = (h0 / r + q) * sgn(flow);
    }
}

fn pbvcoeff(pr: &mut Project, k: usize) {
    let setting = pr.hyd.link_setting[k];
    if setting == MISSING || setting == 0.0 {
        valvecoeff(pr, k);
    } else {
        let flow = pr.hyd.link_flow[k];
        if pr.net.link[k].km * (flow * flow) > setting {
            valvecoeff(pr, k);
        } else {
            pr.hyd.p[k] = CBIG;
            pr.hyd.y[k] = setting * CBIG;
        }
    }
}

fn tcvcoeff(pr: &mut Project, k: usize) {
    let km = pr.net.link[k].km;
    if pr.hyd.link_setting[k] != MISSING {
        let d = pr.net.link[k].diam;
        pr.net.link[k].km = 0.02517 * pr.hyd.link_setting[k] / ((d * d) * (d * d));
    }
    valvecoeff(pr, k);
    pr.net.link[k].km = km;
}

fn pcvcoeff(pr: &mut Project, k: usize) {
    let km = pr.net.link[k].km;
    if pr.hyd.link_setting[k] != MISSING {
        pr.net.link[k].km = pr.net.link[k].r;
    }
    valvecoeff(pr, k);
    pr.net.link[k].km = km;
}

fn prvcoeff(pr: &mut Project, k: usize, n1: usize, n2: usize) {
    let i = pr.sm.row[n1];
    let j = pr.sm.row[n2];
    let hset = pr.net.node[n2].el + pr.hyd.link_setting[k];
    if pr.hyd.link_status[k] == Status::Active {
        pr.hyd.p[k] = 0.0;
        pr.hyd.y[k] = pr.hyd.link_flow[k] + pr.hyd.xflow[n2];
        pr.sm.f[j] += hset * CBIG;
        pr.sm.aii[j] += CBIG;
        if pr.hyd.xflow[n2] < 0.0 {
            pr.sm.f[i] += pr.hyd.xflow[n2];
        }
        return;
    }
    valvecoeff(pr, k);
    open_valve_terms(pr, k, i, j);
}

fn psvcoeff(pr: &mut Project, k: usize, n1: usize, n2: usize) {
    let i = pr.sm.row[n1];
    let j = pr.sm.row[n2];
    let hset = pr.net.node[n1].el + pr.hyd.link_setting[k];
    if pr.hyd.link_status[k] == Status::Active {
        pr.hyd.p[k] = 0.0;
        pr.hyd.y[k] = pr.hyd.link_flow[k] - pr.hyd.xflow[n1];
        pr.sm.f[i] += hset * CBIG;
        pr.sm.aii[i] += CBIG;
        if pr.hyd.xflow[n1] > 0.0 {
            pr.sm.f[j] += pr.hyd.xflow[n1];
        }
        let ndx = pr.sm.ndx[k];
        pr.sm.aij[ndx] -= 1.0 / CBIG;
        pr.sm.aii[j] += 1.0 / CBIG;
        return;
    }
    valvecoeff(pr, k);
    open_valve_terms(pr, k, i, j);
}

fn fcvcoeff(pr: &mut Project, k: usize, n1: usize, n2: usize) {
    let q = pr.hyd.link_setting[k];
    let i = pr.sm.row[n1];
    let j = pr.sm.row[n2];
    if pr.hyd.link_status[k] == Status::Active {
        pr.hyd.xflow[n1] -= q;
        pr.hyd.xflow[n2] += q;
        pr.hyd.y[k] = pr.hyd.link_flow[k] - q;
        pr.sm.f[i] -= q;
        pr.sm.f[j] += q;
        pr.hyd.p[k] = 1.0 / CBIG;
        let p = pr.hyd.p[k];
        let ndx = pr.sm.ndx[k];
        pr.sm.aij[ndx] -= p;
        pr.sm.aii[i] += p;
        pr.sm.aii[j] += p;
    } else {
        valvecoeff(pr, k);
        open_valve_terms(pr, k, i, j);
    }
}

/// The matrix terms shared by PRV, PSV and FCV when not active.
fn open_valve_terms(pr: &mut Project, k: usize, i: usize, j: usize) {
    let p = pr.hyd.p[k];
    let dy = pr.hyd.y[k] - pr.hyd.link_flow[k];
    let ndx = pr.sm.ndx[k];
    pr.sm.aij[ndx] -= p;
    pr.sm.aii[i] += p;
    pr.sm.aii[j] += p;
    pr.sm.f[i] += dy;
    pr.sm.f[j] -= dy;
}

/// `valvecoeff`: a valve treated as an open or closed link.
pub fn valvecoeff(pr: &mut Project, k: usize) {
    let flow = pr.hyd.link_flow[k];
    if pr.hyd.link_status[k] <= Status::Closed {
        pr.hyd.p[k] = 1.0 / CBIG;
        pr.hyd.y[k] = flow;
        return;
    }
    let km = pr.net.link[k].km;
    if km > 0.0 {
        let q = flow.abs();
        let mut hgrad = 2.0 * km * q;
        let hloss;
        if hgrad < pr.hyd.rqtol {
            hgrad = pr.hyd.rqtol / 2.0;
            hloss = flow * hgrad;
        } else {
            hloss = flow * hgrad / 2.0;
        }
        pr.hyd.p[k] = 1.0 / hgrad;
        pr.hyd.y[k] = hloss / hgrad;
    } else {
        pr.hyd.p[k] = 1.0 / CSMALL;
        pr.hyd.y[k] = flow;
    }
}
