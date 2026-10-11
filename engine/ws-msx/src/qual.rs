// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxqual.c, msxchem.c, msxtank.c). See LICENSES/EPANET-MSX.txt.

//! Water quality routing: Lagrangian segments advected through pipes, mixed at nodes
//! in topological order, reacted in place, and the four tank mixing models.

use ws_solver::HydRecord;

use crate::chem::{Chem, Rates};
use crate::fp::{abs_c, abs_f32, max_c, min_c, pow};
use crate::segs::{NIL, Segs};
use crate::types::*;

/// Stagnant flow tolerance: 0.005 gpm in cfs.
const Q_STAGNANT: f64 = 0.005 / GPM_PER_CFS;

const POSITIVE: i32 = 1;
const ZERO_FLOW: i32 = 0;
const NEGATIVE: i32 = -1;

/// `LINKVOL(k)`
fn linkvol(m: &Model, k: usize) -> f64 {
    let l = &m.links[k];
    0.785398 * l.len * (l.diam * l.diam)
}

/// Mass balance components per species (`SmassBalance`).
#[derive(Clone, Debug, Default)]
pub struct MassBalance {
    pub initial: Vec<f64>,
    pub inflow: Vec<f64>,
    pub indisperse: Vec<f64>,
    pub outflow: Vec<f64>,
    pub reacted: Vec<f64>,
    pub final_: Vec<f64>,
    pub ratio: Vec<f64>,
}

/// The routing state (the run-time part of `MSXproject`).
#[derive(Clone, Debug, Default)]
pub struct Qual {
    pub node_c: Vec<Vec<f64>>,
    pub link_nsegs: Vec<i32>,
    pub link_reacted: Vec<Vec<f64>>,
    pub link_hydvar: Vec<[f64; MAX_HYD_VARS]>,
    pub tank_hstep: Vec<f64>,
    pub tank_v: Vec<f64>,
    pub tank_c: Vec<Vec<f64>>,
    pub tank_reacted: Vec<Vec<f64>>,
    pub pat_interval: Vec<i64>,
    pub pat_current: Vec<usize>,
    pub segs: Segs,
    pub first_seg: Vec<usize>,
    pub last_seg: Vec<usize>,
    pub new_seg: Vec<usize>,
    pub flow_dir: Vec<i32>,
    pub c1: Vec<f64>,
    pub mass_in: Vec<f64>,
    pub source_in: Vec<f64>,
    pub sorted_nodes: Vec<usize>,
    /// For each node, (opposite node, link), last link first as msxproj.c builds them.
    pub adjlist: Vec<Vec<(usize, usize)>>,
    pub d: Vec<f32>,
    pub h: Vec<f32>,
    pub q: Vec<f32>,
    pub s: Vec<f32>,
    pub has_wall_species: bool,
    pub qtime: i64,
    pub htime: i64,
    pub rtime: i64,
    pub dur: i64,
    pub nperiods: i32,
    pub saveflag: bool,
    pub rptflag: bool,
    pub mass: MassBalance,
    pub records: Vec<HydRecord>,
    pub hyd_next: usize,
    pub dispersion: crate::dispersion::Dispersion,
}

/// Results the routing hands to the output file at each reporting time.
pub trait Saver {
    fn save_results(&mut self, m: &Model, q: &Qual);
}

impl Qual {
    /// `MSXqual_open` (memory) and `buildadjlists`.
    pub fn open(m: &Model) -> Qual {
        let nsp1 = m.nsp() + 1;
        let nn = m.nobjects[NODE];
        let nl = m.nobjects[LINK];
        let nt = m.nobjects[TANK];
        let n = nl + nt + 1;
        let mut adjlist = vec![Vec::new(); nn + 1];
        for k in 1..=nl {
            let (i, j) = (m.links[k].n1, m.links[k].n2);
            adjlist[i].push((j, k));
            adjlist[j].push((i, k));
        }
        for a in &mut adjlist {
            a.reverse();
        }
        let zeros = vec![0.0; nsp1];
        Qual {
            node_c: vec![zeros.clone(); nn + 1],
            link_nsegs: vec![0; nl + 1],
            link_reacted: vec![zeros.clone(); nl + 1],
            link_hydvar: vec![[0.0; MAX_HYD_VARS]; nl + 1],
            tank_hstep: vec![0.0; nt + 1],
            tank_v: vec![0.0; nt + 1],
            tank_c: vec![zeros.clone(); nt + 1],
            tank_reacted: vec![zeros.clone(); nt + 1],
            pat_interval: vec![0; m.nobjects[PATTERN] + 1],
            pat_current: vec![0; m.nobjects[PATTERN] + 1],
            segs: Segs::new(m.nsp()),
            first_seg: vec![NIL; n],
            last_seg: vec![NIL; n],
            new_seg: vec![NIL; n],
            flow_dir: vec![ZERO_FLOW; n],
            c1: zeros.clone(),
            mass_in: zeros.clone(),
            source_in: zeros.clone(),
            sorted_nodes: vec![0; nn + 1],
            adjlist,
            d: vec![0.0; nn + 1],
            h: vec![0.0; nn + 1],
            q: vec![0.0; nl + 1],
            s: vec![0.0; nl + 1],
            has_wall_species: m.species[1..].iter().any(|s| s.kind == WALL),
            mass: MassBalance {
                initial: zeros.clone(),
                inflow: zeros.clone(),
                indisperse: zeros.clone(),
                outflow: zeros.clone(),
                reacted: zeros.clone(),
                final_: zeros.clone(),
                ratio: zeros,
            },
            dispersion: crate::dispersion::Dispersion::open(m),
            ..Qual::default()
        }
    }

    /// `MSXqual_getNodeQual`
    pub fn node_qual(&self, m: &Model, j: usize, sp: usize) -> f64 {
        if m.species[sp].kind == WALL {
            return 0.0;
        }
        let k = m.nodes[j].tank;
        if k > 0 && m.tanks[k].a > 0.0 {
            return self.tank_c[k][sp];
        }
        self.node_c[j][sp]
    }

    /// `MSXqual_getLinkQual`
    pub fn link_qual(&self, m: &Model, k: usize, sp: usize) -> f64 {
        let mut vsum = 0.0;
        let mut msum = 0.0;
        let mut seg = self.first_seg[k];
        while seg != NIL {
            let v = self.segs.v(seg);
            vsum += v;
            msum += self.segs.c(seg)[sp] * v;
            seg = self.segs.prev(seg);
        }
        if vsum > 0.0 {
            msum / vsum
        } else {
            (self.node_qual(m, m.links[k].n1, sp) + self.node_qual(m, m.links[k].n2, sp)) / 2.0
        }
    }

    /// `MSXqual_isSame`
    fn is_same(m: &Model, c1: &[f64], c2: &[f64]) -> bool {
        for sp in 1..=m.nsp() {
            if (c1[sp] - c2[sp]).abs() >= m.species[sp].a_tol {
                return false;
            }
        }
        true
    }

    /// `MSXqual_addSeg`: add a segment at the upstream end of link (or tank) `k`.
    fn add_seg(&mut self, m: &Model, k: usize, seg: usize) {
        self.segs.meta[seg].prev = NIL;
        self.segs.meta[seg].next = NIL;
        if self.first_seg[k] == NIL {
            self.first_seg[k] = seg;
        }
        let last = self.last_seg[k];
        if last != NIL {
            self.segs.meta[last].prev = seg;
            self.segs.meta[seg].next = last;
        }
        self.last_seg[k] = seg;
        if k <= m.nobjects[LINK] {
            self.link_nsegs[k] += 1;
        }
    }

    /// `MSXqual_reversesegs`
    fn reverse_segs(&mut self, k: usize) {
        let mut seg = self.first_seg[k];
        self.first_seg[k] = self.last_seg[k];
        self.last_seg[k] = seg;
        let mut pseg = NIL;
        while seg != NIL {
            let cseg = self.segs.meta[seg].prev;
            self.segs.meta[seg].prev = pseg;
            self.segs.meta[seg].next = cseg;
            pseg = seg;
            seg = cseg;
        }
    }

    /// `MSXqual_init` (the part that resets state).
    pub fn init(&mut self, m: &Model) {
        let nsp = m.nsp();
        for i in 1..=m.nobjects[NODE] {
            self.node_c[i][1..=nsp].copy_from_slice(&m.nodes[i].c0[1..=nsp]);
        }
        for r in &mut self.link_reacted[1..] {
            r.fill(0.0);
        }
        for i in 1..=m.nobjects[TANK] {
            self.tank_hstep[i] = 0.0;
            self.tank_v[i] = m.tanks[i].v0;
            let n = m.tanks[i].node;
            self.tank_c[i][1..=nsp].copy_from_slice(&m.nodes[n].c0[1..=nsp]);
            self.tank_reacted[i].fill(0.0);
        }
        for i in 1..=m.nobjects[PATTERN] {
            self.pat_interval[i] = 0;
            self.pat_current[i] = 0;
        }
        let nrpt = m.nodes[1..].iter().filter(|n| n.rpt).count()
            + m.links[1..].iter().filter(|l| l.rpt).count();
        let nsp_rpt = m.species[1..].iter().filter(|s| s.rpt).count();
        self.rptflag = nrpt > 0 && nsp_rpt > 0;
        if self.rptflag {
            self.saveflag = true;
        }
        self.segs.reset();
        self.hyd_next = 0;
        self.htime = 0;
        self.qtime = 0;
        self.rtime = m.rstart * 1000;
        self.nperiods = 0;
        let mb = &mut self.mass;
        for v in [
            &mut mb.initial,
            &mut mb.final_,
            &mut mb.inflow,
            &mut mb.indisperse,
            &mut mb.outflow,
            &mut mb.reacted,
            &mut mb.ratio,
        ] {
            v.fill(0.0);
        }
    }

    /// `getHydVars`: the next hydraulic solution.
    fn get_hyd_vars(&mut self) -> i32 {
        let Some(r) = self.records.get(self.hyd_next) else {
            return ERR_READ_HYD_FILE;
        };
        self.hyd_next += 1;
        let hydtime = r.htime;
        self.d[1..].copy_from_slice(r.demand());
        self.h[1..].copy_from_slice(r.head());
        self.q[1..].copy_from_slice(r.flow());
        for (s, v) in self.s[1..].iter_mut().zip(r.status()) {
            *s = v;
        }
        for q in &mut self.q[1..] {
            if f64::from(*q).abs() < Q_STAGNANT {
                *q = 0.0;
            }
        }
        self.htime = (hydtime + r.hydstep) * 1000;
        0
    }

    /// `evalHydVariables`
    fn eval_hyd_variables(&mut self, m: &Model, k: usize) {
        let l = &m.links[k];
        let diam = l.diam;
        let length = l.len;
        let q = self.q[k];
        let hv = &mut self.link_hydvar[k];
        hv[DIAMETER] = diam * m.ucf[LENGTH_UNITS];
        hv[LENGTH] = length * m.ucf[LENGTH_UNITS];
        hv[FLOW] = f64::from(q).abs() * m.ucf[FLOW_UNITS];
        hv[VELOCITY] = if diam == 0.0 {
            0.0
        } else {
            f64::from(q).abs() * 4.0 / PI / (diam * diam)
        };
        hv[REYNOLDS] = hv[VELOCITY] * diam / VISCOS;
        hv[VELOCITY] *= m.ucf[LENGTH_UNITS];
        if l.len == 0.0 {
            hv[FRICTION] = 0.0;
        } else {
            let dh = abs_f32(self.h[l.n1] - self.h[l.n2]);
            let qd = f64::from(q);
            hv[FRICTION] = 39.725 * f64::from(dh) * pow(diam, 5.0) / l.len / (qd * qd);
        }
        hv[SHEAR] = hv[VELOCITY] * (hv[FRICTION] / 8.0).sqrt();
        hv[AREAVOL] = 1.0;
        if diam > 0.0 {
            let mut av = 4.0 / diam;
            av *= m.ucf[AREA_UNITS];
            av /= L_PER_FT3;
            hv[AREAVOL] = av;
        }
        hv[ROUGHNESS] = l.roughness;
    }

    /// `initSegs`
    fn init_segs(&mut self, m: &Model, chem: &mut Chem) {
        let nsp = m.nsp();
        for k in 1..=m.nobjects[LINK] {
            let q = f64::from(self.q[k]);
            self.flow_dir[k] = if q.abs() < Q_STAGNANT {
                ZERO_FLOW
            } else if q > 0.0 {
                POSITIVE
            } else {
                NEGATIVE
            };
            self.last_seg[k] = NIL;
            self.first_seg[k] = NIL;
            self.new_seg[k] = NIL;
            let j = m.links[k].n2;
            for sp in 1..=nsp {
                self.c1[sp] = if m.links[k].c0[sp] != MISSING {
                    m.links[k].c0[sp]
                } else if m.species[sp].kind == BULK {
                    m.nodes[j].c0[sp]
                } else {
                    0.0
                };
            }
            chem.equil_link(m, k, &self.link_hydvar[k], &mut self.c1);
            let v = linkvol(m, k);
            if v > 0.0 {
                let ninit = 100.min(m.max_segments);
                for _ in 0..ninit {
                    let s = self
                        .segs
                        .get_free_seg(v / (1.0 * f64::from(ninit)), &self.c1);
                    self.add_seg(m, k, s);
                }
            }
        }
        for j in 1..=m.nobjects[TANK] {
            if m.tanks[j].a == 0.0 {
                continue;
            }
            let n = m.tanks[j].node;
            self.c1[1..=nsp].copy_from_slice(&m.nodes[n].c0[1..=nsp]);
            let k = m.nobjects[LINK] + j;
            self.last_seg[k] = NIL;
            self.first_seg[k] = NIL;
            chem.equil_node(m, j, &mut self.c1);
            if m.tanks[j].mix_model == MIX2 {
                let mut v = max_c(0.0, self.tank_v[j] - m.tanks[j].v_mix);
                let s = self.segs.get_free_seg(v, &self.c1);
                self.add_seg(m, k, s);
                v = self.tank_v[j] - v;
                let s = self.segs.get_free_seg(v, &self.c1);
                self.add_seg(m, k, s);
            } else {
                let s = self.segs.get_free_seg(self.tank_v[j], &self.c1);
                self.add_seg(m, k, s);
            }
        }
        let mut initial = std::mem::take(&mut self.mass.initial);
        self.find_stored_mass(m, &mut initial);
        self.mass.initial = initial;
    }

    /// `flowdirchanged`
    fn flow_dir_changed(&mut self, m: &Model) -> bool {
        let mut changed = false;
        for k in 1..=m.nobjects[LINK] {
            let q = f64::from(self.q[k]);
            let newdir = if q.abs() < Q_STAGNANT {
                ZERO_FLOW
            } else if q < 0.0 {
                NEGATIVE
            } else {
                POSITIVE
            };
            if newdir * self.flow_dir[k] < 0 {
                self.reverse_segs(k);
            }
            if newdir != self.flow_dir[k] {
                changed = true;
            }
            self.flow_dir[k] = newdir;
        }
        changed
    }

    /// `MSXqual_step`: advance one quality time step. Returns the time reached and the
    /// time left in seconds, and an error code (0 if none). The caller saves the final
    /// results when no time is left, as `MSXqual_step` does.
    pub fn step<S: Saver>(&mut self, m: &Model, chem: &mut Chem, saver: &mut S) -> (f64, f64, i32) {
        let mut errcode = 0;
        let mut tstep = m.qstep;
        if self.qtime + tstep > self.dur {
            tstep = self.dur - self.qtime;
        }
        loop {
            let mut dt = tstep;
            let hstep = self.htime - self.qtime;
            if hstep <= dt {
                dt = hstep;
                if dt > 0 && errcode <= 100 {
                    errcode = self.transport(m, chem, dt);
                }
                self.qtime += dt;
                if self.qtime == self.htime {
                    if errcode <= 100 {
                        errcode = self.get_hyd_vars();
                    }
                    for kl in 1..=m.nobjects[LINK] {
                        if m.links[kl].len == 0.0 {
                            continue;
                        }
                        self.eval_hyd_variables(m, kl);
                    }
                    if self.qtime < self.dur {
                        let changed = if self.qtime == 0 {
                            self.init_segs(m, chem);
                            true
                        } else {
                            self.flow_dir_changed(m)
                        };
                        if changed && errcode <= 100 {
                            errcode = self.sort_nodes(m);
                        }
                    }
                }
                if self.saveflag && self.qtime == self.rtime {
                    if errcode <= 100 {
                        saver.save_results(m, self);
                    }
                    self.rtime += m.rstep * 1000;
                    self.nperiods += 1;
                }
            } else {
                if errcode <= 100 {
                    errcode = self.transport(m, chem, dt);
                }
                self.qtime += dt;
            }
            tstep -= dt;
            if errcode != 0 || tstep <= 0 {
                break;
            }
        }
        let t = self.qtime as f64 / 1000.0;
        let tleft = (self.dur - self.qtime) as f64 / 1000.0;
        if tleft <= 0.0 && self.saveflag {
            let mut fin = std::mem::take(&mut self.mass.final_);
            self.find_stored_mass(m, &mut fin);
            self.mass.final_ = fin;
            for sp in 1..=m.nsp() {
                let mut sreacted = 0.0;
                for k in 1..=m.nobjects[LINK] {
                    sreacted += self.link_reacted[k][sp];
                }
                for k in 1..=m.nobjects[TANK] {
                    sreacted += self.tank_reacted[k][sp];
                }
                let mb = &mut self.mass;
                mb.reacted[sp] = sreacted;
                let mut smassin = mb.initial[sp] + mb.inflow[sp] + mb.indisperse[sp];
                let mut smassout = mb.outflow[sp] + mb.final_[sp];
                if sreacted < 0.0 {
                    smassout -= sreacted;
                } else {
                    smassin += sreacted;
                }
                mb.ratio[sp] = if smassin == 0.0 {
                    1.0
                } else {
                    smassout / smassin
                };
            }
        }
        (t, tleft, errcode)
    }

    /// `transport`: route and react over a period of constant hydraulics.
    fn transport(&mut self, m: &Model, chem: &mut Chem, tstep: i64) -> i32 {
        chem.vars.math.flag = false;
        chem.vars.math.msg.clear();
        let mut qtime = 0;
        while qtime < tstep {
            let dt64 = m.qstep.min(tstep - qtime);
            qtime += dt64;
            let dt = dt64 as f64 / 1000.0;
            let errcode = self.react(m, chem, dt);
            if errcode != 0 {
                return errcode;
            }
            self.advect_segs(m, dt);
            self.topological_transport(m, chem, dt);
            if chem.vars.math.flag {
                return ERR_ILLEGAL_MATH;
            }
        }
        0
    }

    /// `MSXchem_react`
    fn react(&mut self, m: &Model, chem: &mut Chem, dt: f64) -> i32 {
        let mut errcode = 0;
        for k in 1..=chem.lists.n_pipe_rate {
            let sp = chem.lists.pipe_rate[k];
            chem.atol[k] = m.species[sp].a_tol;
            chem.rtol[k] = m.species[sp].r_tol;
        }
        for k in 1..=m.nobjects[LINK] {
            if m.links[k].len == 0.0 {
                continue;
            }
            chem.vars.hydvar[1..].copy_from_slice(&self.link_hydvar[k][1..]);
            // As in the C code, only the last pipe's error code survives the loop.
            errcode = self.eval_pipe_reactions(m, chem, k, dt);
        }
        if errcode != 0 {
            return errcode;
        }
        for k in 1..=chem.lists.n_tank_rate {
            let sp = chem.lists.tank_rate[k];
            chem.atol[k] = m.species[sp].a_tol;
            chem.rtol[k] = m.species[sp].r_tol;
        }
        for k in 1..=m.nobjects[TANK] {
            if m.tanks[k].a == 0.0 {
                continue;
            }
            errcode = self.eval_tank_reactions(m, chem, k, dt);
            if errcode != 0 {
                return errcode;
            }
        }
        errcode
    }

    /// Integrate the rate species of one segment (shared by pipes and tanks).
    fn integrate_segment(
        m: &Model,
        chem: &mut Chem,
        tank: bool,
        c: &mut [f64],
        dh: &mut f64,
        tstep: f64,
    ) -> i32 {
        let nsp = m.nsp();
        let (species, n) = if tank {
            (&chem.lists.tank_rate, chem.lists.n_tank_rate)
        } else {
            (&chem.lists.pipe_rate, chem.lists.n_pipe_rate)
        };
        for i in 1..=n {
            chem.yrate[i] = c[species[i]];
        }
        let mut ierr = 0;
        if m.solver == EUL {
            chem.ytmp.copy_from_slice(&chem.yrate);
            let mut rates = Rates {
                m,
                l: &chem.lists,
                vars: &mut chem.vars,
                eq: &mut chem.equil,
                tank,
            };
            crate::solvers::System::eval(&mut rates, 0.0, &chem.ytmp, n, &mut chem.yrate);
            for i in 1..=n {
                let sp = chem.lists_rate(tank, i);
                let x = c[sp] + chem.yrate[i] * tstep;
                c[sp] = max_c(x, 0.0);
            }
        } else {
            let mut rates = Rates {
                m,
                l: &chem.lists,
                vars: &mut chem.vars,
                eq: &mut chem.equil,
                tank,
            };
            if let Some(rk5) = &mut chem.rk5 {
                ierr = rk5.integrate(
                    &mut chem.yrate,
                    n,
                    0.0,
                    tstep,
                    dh,
                    &chem.atol,
                    &chem.rtol,
                    &mut rates,
                );
            }
            if let Some(ros2) = &mut chem.ros2 {
                ierr = ros2.integrate(
                    &mut chem.yrate,
                    n,
                    0.0,
                    tstep,
                    dh,
                    &chem.atol,
                    &chem.rtol,
                    &mut rates,
                );
            }
            c[1..=nsp].copy_from_slice(&chem.vars.c1[1..=nsp]);
            for i in 1..=n {
                let sp = chem.lists_rate(tank, i);
                c[sp] = max_c(chem.yrate[i], 0.0);
            }
        }
        ierr
    }

    /// `evalPipeReactions`
    fn eval_pipe_reactions(&mut self, m: &Model, chem: &mut Chem, k: usize, dt: f64) -> i32 {
        let nsp = m.nsp();
        let tstep = dt / m.ucf[RATE_UNITS];
        chem.vars.the_link = k;
        let mut seg = self.first_seg[k];
        while seg != NIL {
            {
                let (c, lastc) = self.segs.c_and_lastc(seg);
                chem.vars.c1[1..=nsp].copy_from_slice(&c[1..=nsp]);
                lastc[1..=nsp].copy_from_slice(&c[1..=nsp]);
            }
            if dt > 0.0 {
                let mut dh = self.segs.meta[seg].hstep;
                let ierr =
                    Self::integrate_segment(m, chem, false, self.segs.c_mut(seg), &mut dh, tstep);
                if m.solver != EUL {
                    self.segs.meta[seg].hstep = dh;
                }
                if ierr < 0 {
                    return ERR_INTEGRATOR;
                }
                let v = self.segs.v(seg);
                let diam = m.links[k].diam;
                let (c, lastc) = self.segs.c_and_lastc(seg);
                let reacted = &mut self.link_reacted[k];
                for sp in 1..=nsp {
                    if m.species[sp].kind == BULK {
                        reacted[sp] += v * (c[sp] - lastc[sp]) * L_PER_FT3;
                    } else if diam > 0.0 {
                        reacted[sp] += v * 4.0 / diam * m.ucf[AREA_UNITS] * (c[sp] - lastc[sp]);
                    }
                    lastc[sp] = c[sp];
                }
            }
            let errcode = chem.equil_link(m, k, &self.link_hydvar[k], self.segs.c_mut(seg));
            if errcode != 0 {
                return errcode;
            }
            seg = self.segs.prev(seg);
        }
        0
    }

    /// `evalTankReactions`
    fn eval_tank_reactions(&mut self, m: &Model, chem: &mut Chem, k: usize, dt: f64) -> i32 {
        let nsp = m.nsp();
        let tstep = dt / m.ucf[RATE_UNITS];
        chem.vars.the_tank = k;
        chem.vars.the_node = m.tanks[k].node;
        let mut seg = self.first_seg[m.nobjects[LINK] + k];
        while seg != NIL {
            {
                let (c, lastc) = self.segs.c_and_lastc(seg);
                chem.vars.c1[1..=nsp].copy_from_slice(&c[1..=nsp]);
                lastc[1..=nsp].copy_from_slice(&c[1..=nsp]);
            }
            if dt > 0.0 {
                let mut dh = self.tank_hstep[k];
                let ierr =
                    Self::integrate_segment(m, chem, true, self.segs.c_mut(seg), &mut dh, tstep);
                if m.solver != EUL {
                    self.segs.meta[seg].hstep = dh;
                }
                if ierr < 0 {
                    return ERR_INTEGRATOR;
                }
            }
            let errcode = chem.equil_node(m, k, self.segs.c_mut(seg));
            if errcode != 0 {
                return errcode;
            }
            let v = self.segs.v(seg);
            let (c, lastc) = self.segs.c_and_lastc(seg);
            let reacted = &mut self.tank_reacted[k];
            for sp in 1..=nsp {
                if m.species[sp].kind == BULK {
                    reacted[sp] += v * (c[sp] - lastc[sp]) * L_PER_FT3;
                }
                lastc[sp] = c[sp];
            }
            seg = self.segs.prev(seg);
        }
        0
    }

    /// `advectSegs`
    fn advect_segs(&mut self, m: &Model, dt: f64) {
        for k in 1..=m.nobjects[LINK] {
            self.c1.fill(0.0);
            let s = self.segs.get_free_seg(0.0, &self.c1);
            self.new_seg[k] = s;
            if m.links[k].len == 0.0 || self.q[k] == 0.0 {
                continue;
            }
            if self.has_wall_species {
                self.new_seg_wall_qual(m, k, dt, s);
                self.shift_seg_wall_qual(m, k, dt);
            }
        }
    }

    /// `getNewSegWallQual`
    fn new_seg_wall_qual(&mut self, m: &Model, k: usize, dt: f64, newseg: usize) {
        let nsp = m.nsp();
        let v = linkvol(m, k);
        let mut vin = f64::from(abs_f32(self.q[k])) * dt;
        if vin > v {
            vin = v;
        }
        let mut seg = self.last_seg[k];
        let mut vsum = 0.0;
        let mut vleft = vin;
        for sp in 1..=nsp {
            if m.species[sp].kind == WALL {
                self.segs.c_mut(newseg)[sp] = 0.0;
            }
        }
        while vleft > 0.0 && seg != NIL {
            let mut vadded = self.segs.v(seg);
            if vadded > vleft {
                vadded = vleft;
            }
            vsum += vadded;
            vleft -= vadded;
            for sp in 1..=nsp {
                if m.species[sp].kind == WALL {
                    let add = vadded * self.segs.c(seg)[sp];
                    self.segs.c_mut(newseg)[sp] += add;
                }
            }
            seg = self.segs.next(seg);
        }
        if vsum > 0.0 {
            for sp in 1..=nsp {
                if m.species[sp].kind == WALL {
                    self.segs.c_mut(newseg)[sp] /= vsum;
                }
            }
        }
    }

    /// `shiftSegWallQual`
    fn shift_seg_wall_qual(&mut self, m: &Model, k: usize, dt: f64) {
        let nsp = m.nsp();
        let v = linkvol(m, k);
        let mut vin = abs_c(f64::from(self.q[k])) * dt;
        if vin > v {
            vin = v;
        }
        let mut vstart = vin;
        let mut seg1 = self.last_seg[k];
        while seg1 != NIL {
            if vstart >= v {
                break;
            }
            self.c1.fill(0.0);
            let mut vend = vstart + self.segs.v(seg1);
            if vend > v {
                vend = v;
            }
            let mut vcur = vstart;
            let mut vsum = 0.0;
            let mut seg2 = self.last_seg[k];
            while seg2 != NIL {
                let v2 = self.segs.v(seg2);
                if v2 == 0.0 {
                    seg2 = self.segs.next(seg2);
                    continue;
                }
                vsum += v2;
                if vsum >= vstart && vsum <= vend {
                    for sp in 1..=nsp {
                        if m.species[sp].kind == WALL {
                            self.c1[sp] += (vsum - vcur) * self.segs.c(seg2)[sp];
                        }
                    }
                    vcur = vsum;
                }
                if vsum >= vend {
                    break;
                }
                seg2 = self.segs.next(seg2);
            }
            for sp in 1..=nsp {
                if m.species[sp].kind != WALL {
                    continue;
                }
                if seg2 != NIL {
                    self.c1[sp] += (vend - vcur) * self.segs.c(seg2)[sp];
                }
                let c = self.c1[sp] / (vend - vstart);
                let c1 = self.segs.c_mut(seg1);
                c1[sp] = c;
                if c1[sp] < 0.0 {
                    c1[sp] = 0.0;
                }
            }
            vstart = vend;
            seg1 = self.segs.next(seg1);
        }
    }

    /// `getSourceQual`
    fn source_qual(&mut self, m: &Model, src: &Source) -> f64 {
        let mut c = src.c0;
        if src.kind == MASS {
            c /= 60.0;
        }
        let i = src.pat;
        if i == 0 {
            return c;
        }
        let values = &m.patterns[i].values;
        let len = values.len() as i64;
        if len == 0 {
            return c;
        }
        let k = (((self.qtime + m.pstart * 1000) / (m.pstep * 1000)) as i32 as i64) % len;
        if k != self.pat_interval[i] {
            if k < self.pat_interval[i] {
                self.pat_current[i] = 0;
                self.pat_interval[i] = 0;
            }
            while self.pat_current[i] < values.len() && self.pat_interval[i] < k {
                self.pat_current[i] += 1;
                self.pat_interval[i] += 1;
            }
        }
        let f = values.get(self.pat_current[i]).copied().unwrap_or(1.0);
        c * f
    }

    /// `addSource`
    fn add_source(&mut self, m: &Model, n: usize, src: &Source, volout: f64, dt: f64) {
        let sp = src.species;
        let mut massadded = 0.0;
        if src.c0 > 0.0 && m.species[sp].kind == BULK {
            let s = self.source_qual(m, src);
            match src.kind {
                CONCEN => {
                    if m.nodes[n].tank == 0 && self.d[n] < 0.0 {
                        massadded = -s * f64::from(self.d[n]) * dt;
                    }
                }
                MASS => massadded = s * dt / L_PER_FT3,
                SETPOINT => {
                    if s > self.node_c[n][sp] {
                        massadded = (s - self.node_c[n][sp]) * volout;
                    }
                }
                FLOWPACED => massadded = s * volout,
                _ => {}
            }
            self.node_c[n][sp] += massadded / volout;
            self.source_in[sp] += massadded;
        }
    }

    /// `sourceInput`
    fn source_input(&mut self, m: &Model, chem: &mut Chem, n: usize, volout: f64, dt: f64) {
        if m.nodes[n].sources.is_empty() {
            return;
        }
        let qcutoff = 10.0 * TINY;
        let qout = volout / dt;
        if qout <= qcutoff {
            return;
        }
        self.source_in.fill(0.0);
        for src in &m.nodes[n].sources {
            self.add_source(m, n, src, volout, dt);
        }
        chem.equil_node(m, 0, &mut self.node_c[n]);
        for sp in 1..=m.nsp() {
            self.mass.inflow[sp] += self.source_in[sp] * L_PER_FT3;
        }
    }

    /// `topological_transport`
    fn topological_transport(&mut self, m: &Model, chem: &mut Chem, dt: f64) {
        let nn = m.nobjects[NODE];
        let mut mass_in = std::mem::take(&mut self.mass_in);
        for j in 1..=nn {
            let n = self.sorted_nodes[j];
            let mut volin = 0.0;
            let mut volout = 0.0;
            mass_in.fill(0.0);
            self.source_in.fill(0.0);
            for a in 0..self.adjlist[n].len() {
                let k = self.adjlist[n][a].1;
                let down = if self.flow_dir[k] < 0 {
                    m.links[k].n1
                } else {
                    m.links[k].n2
                };
                if down == n {
                    self.eval_node_inflow(m, k, dt, &mut volin, &mut mass_in);
                } else {
                    volout += f64::from(self.q[k]).abs();
                }
            }
            if m.nodes[n].tank == 0 {
                volout += f64::from(self.d[n]).max(0.0);
            }
            volout *= dt;
            self.find_node_qual(m, chem, n, volin, &mass_in, volout, dt);
            for a in 0..self.adjlist[n].len() {
                let k = self.adjlist[n][a].1;
                let up = if self.flow_dir[k] < 0 {
                    m.links[k].n2
                } else {
                    m.links[k].n1
                };
                if up == n {
                    self.eval_node_outflow(m, k, n, dt);
                }
            }
        }
        self.mass_in = mass_in;
        for sp in 1..=m.nsp() {
            if m.dispersion.md[sp] > 0.0 || m.dispersion.ld[sp] > 0.0 {
                crate::dispersion::dispersion_pipe(self, m, sp, dt);
                crate::dispersion::solve_nodequal(self, m, sp, dt);
                crate::dispersion::segqual_update(self, m, sp, dt);
            }
        }
    }

    /// `evalnodeoutflow`: release flow at the node's quality into the link's upstream end.
    fn eval_node_outflow(&mut self, m: &Model, k: usize, n: usize, tstep: f64) {
        let nsp = m.nsp();
        let v = f64::from(self.q[k]).abs() * tstep;
        let newseg = self.new_seg[k];
        if v == 0.0 {
            // The C code leaves the unused segment allocated; recycling it changes no result.
            self.segs.remove_seg(newseg);
            self.new_seg[k] = NIL;
            return;
        }
        for sp in 1..=nsp {
            if m.species[sp].kind == BULK {
                self.segs.c_mut(newseg)[sp] = self.node_c[n][sp];
            }
        }
        let seg = self.last_seg[k];
        if seg != NIL {
            let use_new = !Self::is_same(m, self.segs.c(seg), &self.node_c[n])
                && self.link_nsegs[k] < m.max_segments;
            if !use_new {
                let sv = self.segs.v(seg);
                let up = &self.node_c[n];
                let c = self.segs.c_mut(seg);
                for sp in 1..=nsp {
                    if m.species[sp].kind == BULK {
                        c[sp] = (c[sp] * sv + up[sp] * v) / (sv + v);
                    }
                }
                self.segs.meta[seg].v += v;
                self.segs.remove_seg(newseg);
            } else {
                self.segs.meta[newseg].v = v;
                self.add_seg(m, k, newseg);
            }
        } else {
            self.segs.meta[newseg].v = v;
            self.add_seg(m, k, newseg);
        }
        self.new_seg[k] = NIL;
    }

    /// `evalnodeinflow`: draw a link's outflow volume and mass from its leading segments.
    fn eval_node_inflow(
        &mut self,
        m: &Model,
        k: usize,
        tstep: f64,
        volin: &mut f64,
        massin: &mut [f64],
    ) {
        let nsp = m.nsp();
        let q = f64::from(self.q[k]);
        let mut v = q.abs() * tstep;
        while v > 0.0 {
            let seg = self.first_seg[k];
            if seg == NIL {
                break;
            }
            let sv = self.segs.v(seg);
            let vseg = min_c(sv, v);
            *volin += vseg;
            let c = self.segs.c(seg);
            for sp in 1..=nsp {
                massin[sp] += vseg * c[sp] * L_PER_FT3;
            }
            v -= vseg;
            if v >= 0.0 && vseg >= sv {
                let prev = self.segs.prev(seg);
                self.first_seg[k] = prev;
                self.link_nsegs[k] -= 1;
                if prev == NIL {
                    self.last_seg[k] = NIL;
                } else {
                    self.segs.meta[prev].next = NIL;
                }
                self.segs.meta[seg].prev = self.segs.free;
                self.segs.free = seg;
            } else {
                self.segs.meta[seg].v -= vseg;
            }
        }
    }

    /// `findnodequal`
    #[allow(clippy::too_many_arguments)]
    fn find_node_qual(
        &mut self,
        m: &Model,
        chem: &mut Chem,
        n: usize,
        mut volin: f64,
        massin: &[f64],
        volout: f64,
        tstep: f64,
    ) {
        let nsp = m.nsp();
        let j = m.nodes[n].tank;
        if j == 0 {
            volin -= f64::from(self.d[n]).min(0.0) * tstep;
            if volin > 0.0 {
                for sp in 1..=nsp {
                    self.node_c[n][sp] = massin[sp] / volin / L_PER_FT3;
                }
            } else {
                self.no_flow_qual(m, n);
            }
            chem.equil_node(m, 0, &mut self.node_c[n]);
        } else if m.tanks[j].a == 0.0 {
            self.node_c[n][1..=nsp].copy_from_slice(&m.nodes[n].c0[1..=nsp]);
            chem.equil_node(m, 0, &mut self.node_c[n]);
            for sp in 1..=nsp {
                self.mass.inflow[sp] += self.node_c[n][sp] * volout * L_PER_FT3;
                self.mass.outflow[sp] += massin[sp];
            }
        } else {
            for sp in 1..=nsp {
                self.c1[sp] = if volin > 0.0 {
                    massin[sp] / volin / L_PER_FT3
                } else {
                    0.0
                };
            }
            let vnet = volin - volout;
            match m.tanks[j].mix_model {
                MIX1 => self.tank_mix1(m, chem, j, volin, massin, vnet),
                MIX2 => self.tank_mix2(m, chem, j, volin, massin, vnet),
                FIFO => self.tank_mix3(m, j, volin, massin, vnet),
                LIFO => self.tank_mix4(m, j, volin, massin, vnet),
                _ => {}
            }
            for sp in 1..=nsp {
                self.node_c[n][sp] = self.tank_c[j][sp];
            }
            self.tank_v[j] += f64::from(self.d[n]) * tstep;
        }
        self.source_input(m, chem, n, volout, tstep);
        if m.nodes[n].tank == 0 {
            for sp in 1..=nsp {
                if m.species[sp].kind == BULK {
                    self.mass.outflow[sp] +=
                        max_c(0.0, f64::from(self.d[n])) * tstep * self.node_c[n][sp] * L_PER_FT3;
                }
            }
        }
    }

    /// `noflowqual`: a junction without inflow takes the average of its links' ends.
    fn no_flow_qual(&mut self, m: &Model, n: usize) {
        let nsp = m.nsp();
        let mut kount = 0;
        self.node_c[n][1..=nsp].fill(0.0);
        for a in 0..self.adjlist[n].len() {
            let k = self.adjlist[n][a].1;
            let dir = self.flow_dir[k];
            let inflow = (m.links[k].n2 == n && dir >= 0) || (m.links[k].n1 == n && dir < 0);
            if inflow && self.first_seg[k] != NIL {
                let s = self.first_seg[k];
                for sp in 1..=nsp {
                    self.node_c[n][sp] += self.segs.c(s)[sp];
                }
                kount += 1;
            } else if !inflow && self.last_seg[k] != NIL {
                let s = self.last_seg[k];
                for sp in 1..=nsp {
                    self.node_c[n][sp] += self.segs.c(s)[sp];
                }
                kount += 1;
            }
        }
        if kount > 0 {
            for sp in 1..=nsp {
                self.node_c[n][sp] /= f64::from(kount);
            }
        }
    }

    /// `sortNodes`: topological order of nodes from upstream to downstream.
    fn sort_nodes(&mut self, m: &Model) -> i32 {
        let nn = m.nobjects[NODE];
        let mut indegree = vec![0i32; nn + 1];
        let mut stack = vec![0usize; nn + 1];
        let mut stacksize = 0;
        let mut numsorted = 0;
        for k in 1..=m.nobjects[LINK] {
            let n = match self.flow_dir[k] {
                POSITIVE => m.links[k].n2,
                NEGATIVE => m.links[k].n1,
                _ => continue,
            };
            indegree[n] += 1;
        }
        for i in 1..=nn {
            if indegree[i] == 0 {
                stacksize += 1;
                stack[stacksize] = i;
            }
        }
        while numsorted < nn {
            if stacksize == 0 {
                let j = self.select_non_stack_node(m, numsorted, &indegree);
                if j == 0 {
                    break;
                }
                indegree[j] = 0;
                stacksize += 1;
                stack[stacksize] = j;
            }
            let i = stack[stacksize];
            stacksize -= 1;
            numsorted += 1;
            self.sorted_nodes[numsorted] = i;
            for &(_, k) in &self.adjlist[i] {
                if self.flow_dir[k] == 0 {
                    continue;
                }
                let n = if self.flow_dir[k] < 0 {
                    m.links[k].n1
                } else {
                    m.links[k].n2
                };
                if n != i && indegree[n] > 0 {
                    indegree[n] -= 1;
                    if indegree[n] == 0 {
                        stacksize += 1;
                        stack[stacksize] = n;
                    }
                }
            }
        }
        if numsorted < nn { 120 } else { 0 }
    }

    /// `selectnonstacknode`
    fn select_non_stack_node(&self, m: &Model, numsorted: usize, indegree: &[i32]) -> usize {
        for i in (1..=numsorted).rev() {
            let mnode = self.sorted_nodes[i];
            for &(n, _) in &self.adjlist[mnode] {
                if indegree[n] > 0 {
                    return n;
                }
            }
        }
        (1..=m.nobjects[NODE])
            .find(|&i| indegree[i] > 0)
            .unwrap_or(0)
    }

    /// `findstoredmass`
    fn find_stored_mass(&self, m: &Model, mass: &mut [f64]) {
        let nsp = m.nsp();
        mass[1..=nsp].fill(0.0);
        for k in 1..=m.nobjects[LINK] {
            let mut seg = self.first_seg[k];
            while seg != NIL {
                let c = self.segs.c(seg);
                let v = self.segs.v(seg);
                for sp in 1..=nsp {
                    if m.species[sp].kind == BULK {
                        mass[sp] += c[sp] * v * L_PER_FT3;
                    } else {
                        mass[sp] += c[sp] * v * 4.0 / m.links[k].diam * m.ucf[AREA_UNITS];
                    }
                }
                seg = self.segs.prev(seg);
            }
        }
        for i in 1..=m.nobjects[TANK] {
            if m.tanks[i].a == 0.0 {
                continue;
            }
            let mut seg = self.first_seg[m.nobjects[LINK] + i];
            while seg != NIL {
                let c = self.segs.c(seg);
                let v = self.segs.v(seg);
                for sp in 1..=nsp {
                    if m.species[sp].kind == BULK {
                        mass[sp] += c[sp] * v * L_PER_FT3;
                    }
                }
                seg = self.segs.prev(seg);
            }
        }
    }

    /// `MSXtank_mix1`: completely mixed tank.
    fn tank_mix1(
        &mut self,
        m: &Model,
        chem: &mut Chem,
        i: usize,
        vin: f64,
        massin: &[f64],
        vnet: f64,
    ) {
        let k = m.nobjects[LINK] + i;
        let seg = self.first_seg[k];
        if seg != NIL {
            let sv = self.segs.v(seg);
            let vnew = sv + vin;
            for sp in 1..=m.nsp() {
                if m.species[sp].kind != BULK {
                    continue;
                }
                let mut c = self.segs.c(seg)[sp];
                if vnew > 0.0 {
                    c = (c * sv * L_PER_FT3 + massin[sp]) / (vnew * L_PER_FT3);
                }
                c = max_c(0.0, c);
                self.segs.c_mut(seg)[sp] = c;
                self.tank_c[i][sp] = c;
            }
            let meta = &mut self.segs.meta[seg];
            meta.v += vnet;
            meta.v = max_c(0.0, meta.v);
        }
        if vin > 0.0 {
            chem.equil_node(m, i, &mut self.tank_c[i]);
        }
    }

    /// `MSXtank_mix2`: two-compartment tank.
    fn tank_mix2(
        &mut self,
        m: &Model,
        chem: &mut Chem,
        i: usize,
        vin: f64,
        massin: &[f64],
        vnet: f64,
    ) {
        let nsp = m.nsp();
        let k = m.nobjects[LINK] + i;
        let mixzone = self.last_seg[k];
        let stagzone = self.first_seg[k];
        if mixzone == NIL || stagzone == NIL {
            return;
        }
        let vmz = m.tanks[i].v_mix;
        let mut vt = 0.0;
        if vnet > 0.0 {
            let mzv = self.segs.v(mixzone);
            vt = max_c(0.0, mzv + vnet - vmz);
            if vin > 0.0 {
                for sp in 1..=nsp {
                    if m.species[sp].kind != BULK {
                        continue;
                    }
                    let c = self.segs.c(mixzone)[sp];
                    let c = (c * mzv * L_PER_FT3 + massin[sp]) / ((mzv + vin) * L_PER_FT3);
                    self.segs.c_mut(mixzone)[sp] = max_c(0.0, c);
                }
            }
            if vt > 0.0 {
                let szv = self.segs.v(stagzone);
                for sp in 1..=nsp {
                    if m.species[sp].kind != BULK {
                        continue;
                    }
                    let szc = self.segs.c(stagzone)[sp];
                    let mzc = self.segs.c(mixzone)[sp];
                    let c = (szc * szv + mzc * vt) / (szv + vt);
                    self.segs.c_mut(stagzone)[sp] = max_c(0.0, c);
                }
            }
        } else if vnet < 0.0 {
            let szv = self.segs.v(stagzone);
            if szv > 0.0 {
                vt = min_c(szv, -vnet);
            }
            if vin + vt > 0.0 {
                let mzv = self.segs.v(mixzone);
                for sp in 1..=nsp {
                    if m.species[sp].kind != BULK {
                        continue;
                    }
                    let mzc = self.segs.c(mixzone)[sp];
                    let szc = self.segs.c(stagzone)[sp];
                    let c = (mzc * mzv * L_PER_FT3 + massin[sp] + szc * vt * L_PER_FT3)
                        / ((mzv + vin + vt) * L_PER_FT3);
                    self.segs.c_mut(mixzone)[sp] = max_c(0.0, c);
                }
            }
        }
        if vt > 0.0 {
            self.segs.meta[mixzone].v = vmz;
            if vnet > 0.0 {
                self.segs.meta[stagzone].v += vt;
            } else {
                let v = self.segs.meta[stagzone].v - vt;
                self.segs.meta[stagzone].v = max_c(0.0, v);
            }
        } else {
            let mut v = self.segs.meta[mixzone].v + vnet;
            v = min_c(v, vmz);
            v = max_c(0.0, v);
            self.segs.meta[mixzone].v = v;
            self.segs.meta[stagzone].v = 0.0;
        }
        if self.segs.v(mixzone) > 0.0 {
            chem.equil_node(m, i, self.segs.c_mut(mixzone));
        }
        if self.segs.v(stagzone) > 0.0 {
            chem.equil_node(m, i, self.segs.c_mut(stagzone));
        }
        let c = self.segs.c(mixzone);
        self.tank_c[i][1..=nsp].copy_from_slice(&c[1..=nsp]);
    }

    /// `MSXtank_mix3`: first-in, first-out plug flow tank.
    fn tank_mix3(&mut self, m: &Model, i: usize, vin: f64, massin: &[f64], vnet: f64) {
        let nsp = m.nsp();
        let k = m.nobjects[LINK] + i;
        let mut vout = vin - vnet;
        if self.last_seg[k] == NIL || self.first_seg[k] == NIL {
            return;
        }
        if vin > 0.0 {
            let seg = self.last_seg[k];
            for sp in 1..=nsp {
                self.c1[sp] = massin[sp] / (vin * L_PER_FT3);
            }
            if seg != NIL && Self::is_same(m, self.segs.c(seg), &self.c1) {
                let sv = self.segs.v(seg);
                let c1 = &self.c1;
                let c = self.segs.c_mut(seg);
                for sp in 1..=nsp {
                    c[sp] = (c[sp] * sv + c1[sp] * vin) / (sv + vin);
                }
                self.segs.meta[seg].v += vin;
            } else {
                let s = self.segs.get_free_seg(vin, &self.c1);
                self.add_seg(m, k, s);
            }
        }
        let mut vsum = 0.0;
        self.c1.fill(0.0);
        while vout > 0.0 {
            let seg = self.first_seg[k];
            if seg == NIL {
                break;
            }
            let sv = self.segs.v(seg);
            let mut vseg = min_c(sv, vout);
            if seg == self.last_seg[k] {
                vseg = vout;
            }
            vsum += vseg;
            for sp in 1..=nsp {
                self.c1[sp] += self.segs.c(seg)[sp] * vseg * L_PER_FT3;
            }
            vout -= vseg;
            if vout >= 0.0 && vseg >= sv {
                let prev = self.segs.prev(seg);
                if prev != NIL {
                    self.first_seg[k] = prev;
                    self.segs.meta[seg].prev = self.segs.free;
                    self.segs.free = seg;
                }
            } else {
                self.segs.meta[seg].v -= vseg;
            }
        }
        for sp in 1..=nsp {
            if vsum > 0.0 {
                self.tank_c[i][sp] = self.c1[sp] / (vsum * L_PER_FT3);
            } else if self.first_seg[k] == NIL {
                self.tank_c[i][sp] = 0.0;
            } else {
                self.tank_c[i][sp] = self.segs.c(self.first_seg[k])[sp];
            }
        }
    }

    /// `MSXtank_mix4`: last-in, first-out tank.
    fn tank_mix4(&mut self, m: &Model, i: usize, vin: f64, massin: &[f64], mut vnet: f64) {
        let nsp = m.nsp();
        let k = m.nobjects[LINK] + i;
        if self.last_seg[k] == NIL || self.first_seg[k] == NIL {
            return;
        }
        for sp in 1..=nsp {
            self.c1[sp] = if vin > 0.0 {
                massin[sp] / (vin * L_PER_FT3)
            } else {
                0.0
            };
        }
        let last = self.last_seg[k];
        self.tank_c[i][1..=nsp].copy_from_slice(&self.segs.c(last)[1..=nsp]);
        let seg = last;
        if vnet > 0.0 {
            if seg != NIL && Self::is_same(m, self.segs.c(seg), &self.c1) {
                let sv = self.segs.v(seg);
                let c1 = &self.c1;
                let c = self.segs.c_mut(seg);
                for sp in 1..=nsp {
                    c[sp] = (c[sp] * sv + c1[sp] * vnet) / (sv + vnet);
                }
                self.segs.meta[seg].v += vnet;
            } else {
                let s = self.segs.get_free_seg(vnet, &self.c1);
                self.add_seg(m, k, s);
            }
            let last = self.last_seg[k];
            self.tank_c[i][1..=nsp].copy_from_slice(&self.segs.c(last)[1..=nsp]);
        } else if vnet < 0.0 {
            self.c1.fill(0.0);
            let mut vsum = 0.0;
            vnet = -vnet;
            self.reverse_segs(k);
            while vnet > 0.0 {
                let seg = self.first_seg[k];
                if seg == NIL {
                    break;
                }
                let sv = self.segs.v(seg);
                let mut vseg = min_c(sv, vnet);
                if seg == self.last_seg[k] {
                    vseg = vnet;
                }
                vsum += vseg;
                for sp in 1..=nsp {
                    self.c1[sp] += self.segs.c(seg)[sp] * vseg * L_PER_FT3;
                }
                vnet -= vseg;
                if vnet >= 0.0 && vseg >= sv {
                    let prev = self.segs.prev(seg);
                    if prev != NIL {
                        self.first_seg[k] = prev;
                        self.segs.remove_seg(seg);
                    }
                } else {
                    self.segs.meta[seg].v -= vseg;
                }
            }
            self.reverse_segs(k);
            vsum += vin;
            for sp in 1..=nsp {
                if vsum > 0.0 {
                    self.tank_c[i][sp] = (self.c1[sp] + massin[sp]) / (vsum * L_PER_FT3);
                }
            }
        }
    }
}

impl Chem {
    /// The species index of the `i`-th rate species of a pipe or tank.
    pub(crate) fn lists_rate(&self, tank: bool, i: usize) -> usize {
        if tank {
            self.lists.tank_rate[i]
        } else {
            self.lists.pipe_rate[i]
        }
    }
}
