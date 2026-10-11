// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxdispersion.c, smatrix.c). See LICENSES/EPANET-MSX.txt.

//! Longitudinal dispersion for the Lagrangian scheme: per-pipe tridiagonal responses
//! to the initial condition and to unit concentrations at each end, a sparse
//! symmetric system for the junction concentrations (Cholesky, after the
//! minimum-degree ordering of EPANET 2.0's smatrix.c), and the segment update.

use crate::fp::{abs_f32, exp, pow};
use crate::qual::Qual;
use crate::segs::NIL;
use crate::types::*;

const CLOSED: f32 = 2.0;

/// Sparse matrix structure and work arrays (`Sdispersion`).
#[derive(Clone, Debug, Default)]
pub struct Dispersion {
    order: Vec<usize>,
    row: Vec<usize>,
    ndx: Vec<usize>,
    xlnz: Vec<usize>,
    nzsub: Vec<usize>,
    lnz: Vec<usize>,
    ncoeffs: usize,
    link: Vec<usize>,
    first: Vec<usize>,
    temp: Vec<f64>,
    aii: Vec<f64>,
    aij: Vec<f64>,
    f: Vec<f64>,
    pub pipe_dispersion_coeff: Vec<f64>,
    al: Vec<f64>,
    bl: Vec<f64>,
    cl: Vec<f64>,
    rl: Vec<f64>,
    sol: Vec<f64>,
    gam: Vec<f64>,
}

impl Dispersion {
    /// `msx_createsparse` (only when the model asks for dispersion).
    pub fn open(m: &Model) -> Dispersion {
        if !m.dispersion_flag {
            return Dispersion::default();
        }
        let nn = m.nobjects[NODE];
        let nl = m.nobjects[LINK];
        let njuncs = nn - m.nobjects[TANK];
        let mut d = Dispersion {
            order: vec![0; nn + 1],
            row: vec![0; nn + 1],
            ndx: vec![0; nl + 1],
            ..Dispersion::default()
        };

        // buildlists(TRUE): adjacency lists, newest first, marking parallel links.
        let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); nn + 1];
        for k in 1..=nl {
            let (i, j) = (m.links[k].n1, m.links[k].n2);
            let pmark = match adj[i].iter().find(|&&(node, _)| node == j) {
                Some(&(_, link)) => {
                    d.ndx[k] = link;
                    true
                }
                None => {
                    d.ndx[k] = k;
                    false
                }
            };
            adj[i].insert(0, (if pmark { 0 } else { j }, k));
            adj[j].insert(0, (if pmark { 0 } else { i }, k));
        }
        // xparalinks
        for a in &mut adj[1..] {
            a.retain(|&(node, _)| node != 0);
        }
        // countdegree: tanks have zero degree for the reordering.
        let mut degree = vec![0i32; nn + 1];
        for i in 1..=njuncs {
            degree[i] = adj[i].iter().filter(|&&(node, _)| node > 0).count() as i32;
        }

        // reordernodes
        d.ncoeffs = nl;
        for k in 1..=nn {
            d.row[k] = k;
            d.order[k] = k;
        }
        let n = njuncs;
        for k in 1..=n {
            // mindegree
            let mut min = n as i32;
            let mut imin = n;
            for i in k..=n {
                let deg = degree[d.order[i]];
                if deg < min {
                    min = deg;
                    imin = i;
                }
            }
            let knode = d.order[imin];
            // growlist
            let mut a = 0;
            while a < adj[knode].len() {
                let node = adj[knode][a].0;
                if degree[node] > 0 {
                    degree[node] -= 1;
                    // newlink
                    let inode = node;
                    let mut b = a + 1;
                    while b < adj[knode].len() {
                        let jnode = adj[knode][b].0;
                        if degree[jnode] > 0 && !adj[inode].iter().any(|&(x, _)| x == jnode) {
                            d.ncoeffs += 1;
                            adj[inode].insert(0, (jnode, d.ncoeffs));
                            adj[jnode].insert(0, (inode, d.ncoeffs));
                            degree[inode] += 1;
                            degree[jnode] += 1;
                            // Inserting at the front of knode's own list (when inode or
                            // jnode is knode) never happens: knode is not adjacent to itself.
                        }
                        b += 1;
                    }
                }
                a += 1;
            }
            d.order[imin] = d.order[k];
            d.order[k] = knode;
            degree[knode] = 0;
        }
        for k in 1..=n {
            d.row[d.order[k]] = k;
        }

        // storesparse
        d.xlnz = vec![0; n + 2];
        d.nzsub = vec![0; d.ncoeffs + 2];
        d.lnz = vec![0; d.ncoeffs + 2];
        let mut k = 0;
        d.xlnz[1] = 1;
        for i in 1..=n {
            let mut cnt = 0;
            let ii = d.order[i];
            for &(node, link) in &adj[ii] {
                let j = d.row[node];
                if j > i && j <= n {
                    cnt += 1;
                    k += 1;
                    d.nzsub[k] = j;
                    d.lnz[k] = link;
                }
            }
            d.xlnz[i + 1] = d.xlnz[i] + cnt;
        }

        // ordersparse: transpose twice to sort the row indexes of each column.
        let mut nzt = vec![0usize; n + 2];
        for i in 1..=n {
            for k in d.xlnz[i]..d.xlnz[i + 1] {
                nzt[d.nzsub[k]] += 1;
            }
        }
        let mut xlnzt = vec![0usize; n + 2];
        xlnzt[1] = 1;
        for i in 1..=n {
            xlnzt[i + 1] = xlnzt[i] + nzt[i];
        }
        let mut nzsubt = vec![0usize; d.ncoeffs + 2];
        let mut lnzt = vec![0usize; d.ncoeffs + 2];
        transpose(
            n,
            &d.xlnz,
            &d.nzsub,
            &d.lnz,
            &xlnzt,
            &mut nzsubt,
            &mut lnzt,
            &mut nzt,
        );
        let xlnz = d.xlnz.clone();
        transpose(
            n,
            &xlnzt,
            &nzsubt,
            &lnzt,
            &xlnz,
            &mut d.nzsub,
            &mut d.lnz,
            &mut nzt,
        );

        d.aij = vec![0.0; d.ncoeffs + 1];
        d.aii = vec![0.0; nn + 1];
        d.f = vec![0.0; nn + 1];
        d.temp = vec![0.0; nn + 1];
        d.link = vec![0; nn + 1];
        d.first = vec![0; nn + 1];
        d.pipe_dispersion_coeff = vec![0.0; nl + 1];
        let w = usize::try_from(m.max_segments).unwrap_or(0) + 2;
        d.al = vec![0.0; w];
        d.bl = vec![0.0; w];
        d.cl = vec![0.0; w];
        d.rl = vec![0.0; w];
        d.sol = vec![0.0; w];
        d.gam = vec![0.0; w];
        d
    }

    fn ensure_work(&mut self, n: usize) {
        if self.al.len() < n {
            for v in [
                &mut self.al,
                &mut self.bl,
                &mut self.cl,
                &mut self.rl,
                &mut self.sol,
                &mut self.gam,
            ] {
                v.resize(n, 0.0);
            }
        }
    }

    /// `tridiag`: Thomas' algorithm on `a`, `b`, `c` with right-hand side `r`.
    fn tridiag(&mut self, n: usize) {
        let (a, b, c, r, y, gam) = (
            &self.al,
            &self.bl,
            &self.cl,
            &self.rl,
            &mut self.sol,
            &mut self.gam,
        );
        let mut bet = b[0];
        y[0] = r[0] / bet;
        for j in 1..n {
            gam[j] = c[j - 1] / bet;
            bet = b[j] - a[j] * gam[j];
            y[j] = (r[j] - a[j] * y[j - 1]) / bet;
        }
        for j in (0..n.saturating_sub(1)).rev() {
            y[j] -= gam[j + 1] * y[j + 1];
        }
    }

    /// `msx_linsolve`: Cholesky solve of the junction system; 0, or the row at which
    /// the matrix is not positive definite.
    fn linsolve(&mut self, n: usize) -> usize {
        let Dispersion {
            xlnz,
            nzsub,
            lnz,
            link,
            first,
            temp,
            aii,
            aij,
            f: b,
            ..
        } = self;
        temp[..=n].fill(0.0);
        link[..=n].fill(0);
        for j in 1..=n {
            let mut diagj = 0.0;
            let mut k = link[j];
            while k != 0 {
                let newk = link[k];
                let kfirst = first[k];
                let ljk = aij[lnz[kfirst]];
                diagj += ljk * ljk;
                let istrt = kfirst + 1;
                let istop = xlnz[k + 1] - 1;
                if istop >= istrt {
                    first[k] = istrt;
                    let isub = nzsub[istrt];
                    link[k] = link[isub];
                    link[isub] = k;
                    for i in istrt..=istop {
                        let isub = nzsub[i];
                        temp[isub] += aij[lnz[i]] * ljk;
                    }
                }
                k = newk;
            }
            diagj = aii[j] - diagj;
            if diagj <= 0.0 {
                return j;
            }
            diagj = diagj.sqrt();
            aii[j] = diagj;
            let istrt = xlnz[j];
            let istop = xlnz[j + 1].wrapping_sub(1);
            if istop >= istrt && xlnz[j + 1] > 0 {
                first[j] = istrt;
                let isub = nzsub[istrt];
                link[j] = link[isub];
                link[isub] = j;
                for i in istrt..=istop {
                    let isub = nzsub[i];
                    let bj = (aij[lnz[i]] - temp[isub]) / diagj;
                    aij[lnz[i]] = bj;
                    temp[isub] = 0.0;
                }
            }
        }
        for j in 1..=n {
            let bj = b[j] / aii[j];
            b[j] = bj;
            let (istrt, istop) = (xlnz[j], xlnz[j + 1]);
            for i in istrt..istop {
                let isub = nzsub[i];
                b[isub] -= aij[lnz[i]] * bj;
            }
        }
        for j in (1..=n).rev() {
            let mut bj = b[j];
            let (istrt, istop) = (xlnz[j], xlnz[j + 1]);
            for i in istrt..istop {
                let isub = nzsub[i];
                bj -= aij[lnz[i]] * b[isub];
            }
            b[j] = bj / aii[j];
        }
        0
    }
}

#[allow(clippy::too_many_arguments)]
fn transpose(
    n: usize,
    il: &[usize],
    jl: &[usize],
    xl: &[usize],
    ilt: &[usize],
    jlt: &mut [usize],
    xlt: &mut [usize],
    nzt: &mut [usize],
) {
    for v in &mut nzt[1..=n] {
        *v = 0;
    }
    for i in 1..=n {
        for k in il[i]..il[i + 1] {
            let j = jl[k];
            let kk = ilt[j] + nzt[j];
            jlt[kk] = i;
            xlt[kk] = xl[k];
            nzt[j] += 1;
        }
    }
}

/// The source of species `sp` at a node, if any (the first one found).
fn source_for(m: &Model, n: usize, sp: usize) -> Option<&Source> {
    m.nodes[n].sources.iter().find(|s| s.species == sp)
}

/// `dispersion_pipe`: effective dispersion coefficient of each pipe and the segment
/// responses to the initial condition and to each end's concentration.
pub fn dispersion_pipe(q: &mut Qual, m: &Model, sp: usize, tstep: f64) {
    let d0 = m.dispersion.md[sp];
    let mut reynolds = 0.0;
    let mut frictionfactor;
    let mut shearvelocity;
    for k in 1..=m.nobjects[LINK] {
        let mut velocity = 0.0;
        if q.first_seg[k] == NIL {
            continue;
        }
        let diam = m.links[k].diam;
        let len = m.links[k].len;
        let flowrate = if q.s[k] <= CLOSED {
            0.0
        } else {
            f64::from(q.q[k])
        };
        let area = PI * diam * diam / 4.0;
        let mut ldispersion;
        if area > 0.0 && len > 0.0 && flowrate.abs() > 0.0 {
            velocity = flowrate.abs() / area;
            reynolds = velocity * diam / m.dispersion.viscosity;
            let dh = abs_f32(q.h[m.links[k].n1] - q.h[m.links[k].n2]);
            frictionfactor = if f64::from(dh) > 0.00001 {
                39.725 * f64::from(dh) * pow(diam, 5.0) / (len * (flowrate * flowrate))
            } else {
                0.0
            };
            shearvelocity = velocity * (frictionfactor / 8.0).sqrt();
            if d0 < 0.0 {
                ldispersion = m.dispersion.ld[sp];
            } else if reynolds > 2300.0 {
                ldispersion =
                    0.5 * diam * shearvelocity * (10.1 + 577.0 * pow(reynolds / 1000.0, -2.2));
            } else {
                let x = 0.5 * diam * velocity;
                ldispersion = x * x / (48.0 * d0);
                let elpt = len / velocity;
                let interv = 16.0 * d0 * elpt / (0.25 * diam * diam);
                ldispersion *= 1.0 - (1.0 - exp(-interv)) / interv;
                ldispersion += d0;
            }
        } else {
            ldispersion = 0.0;
        }

        if ldispersion < 0.0 {
            q.dispersion.pipe_dispersion_coeff[k] = 0.0;
            continue;
        }
        let domi = if velocity > 0.0 {
            ldispersion / (velocity * velocity * tstep)
        } else {
            1000.0
        };
        if domi >= 0.0 && len * velocity / ldispersion < m.dispersion.peclet_limit {
            q.dispersion.pipe_dispersion_coeff[k] = ldispersion;
        } else {
            q.dispersion.pipe_dispersion_coeff[k] = 0.0;
            continue;
        }
        let asquare = area * area;
        let cons = 2.0 * ldispersion * asquare * tstep;

        // Count the segments first so the work arrays are large enough.
        let mut nseg = 0;
        let mut s = q.first_seg[k];
        while s != NIL {
            nseg += 1;
            s = q.segs.prev(s);
        }
        if nseg == 0 {
            continue;
        }
        let ds = &mut q.dispersion;
        ds.ensure_work(nseg + 2);
        let mut vd = 0.0;
        ds.bl[0] = 1.0;
        ds.cl[0] = 0.0;
        ds.rl[0] = 0.0;
        let mut i = 0;
        let mut seg = q.first_seg[k];
        while seg != NIL {
            i += 1;
            let vself = q.segs.v(seg);
            ds.rl[i] = q.segs.c(seg)[sp];
            seg = q.segs.prev(seg);
            let vu = if seg != NIL { q.segs.v(seg) } else { 0.0 };
            ds.al[i] = -cons / (vself * vself + vself * vd);
            ds.cl[i] = -cons / (vself * vself + vself * vu);
            ds.bl[i] = 1.0 - ds.al[i] - ds.cl[i];
            vd = vself;
        }
        ds.al[nseg + 1] = 0.0;
        ds.bl[nseg + 1] = 1.0;
        ds.rl[nseg + 1] = 0.0;

        let solve = |ds: &mut Dispersion| {
            if reynolds >= 0.0 {
                ds.tridiag(nseg + 2);
            } else {
                let n = nseg + 2;
                let (rl, sol) = (&ds.rl, &mut ds.sol);
                sol[..n].copy_from_slice(&rl[..n]);
            }
        };

        solve(ds);
        let mut seg = q.first_seg[k];
        let mut idx = 1;
        while seg != NIL {
            q.segs.meta[seg].hresponse = ds.sol[idx];
            seg = q.segs.prev(seg);
            idx += 1;
        }
        // --- clear the initial condition; unit concentration downstream
        for p in 1..nseg + 1 {
            ds.rl[p] = 0.0;
        }
        ds.rl[0] = 1.0;
        solve(ds);
        let mut seg = q.first_seg[k];
        let mut idx = 1;
        while seg != NIL {
            q.segs.meta[seg].dresponse = ds.sol[idx];
            seg = q.segs.prev(seg);
            idx += 1;
        }
        // --- unit concentration upstream
        ds.rl[0] = 0.0;
        ds.rl[nseg + 1] = 1.0;
        solve(ds);
        let mut seg = q.first_seg[k];
        let mut idx = 1;
        while seg != NIL {
            q.segs.meta[seg].uresponse = ds.sol[idx];
            seg = q.segs.prev(seg);
            idx += 1;
        }
    }
}

/// `solve_nodequal`: junction concentrations after dispersion.
pub fn solve_nodequal(q: &mut Qual, m: &Model, sp: usize, _tstep: f64) {
    let nn = m.nobjects[NODE];
    let njuncs = nn - m.nobjects[TANK];
    let ds = &mut q.dispersion;
    ds.aii.fill(0.0);
    ds.aij.fill(0.0);
    ds.f.fill(0.0);
    for k in 1..=m.nobjects[LINK] {
        let ld = ds.pipe_dispersion_coeff[k];
        if ld <= 0.0 {
            continue;
        }
        let (mut n1, mut n2) = (m.links[k].n1, m.links[k].n2);
        if q.flow_dir[k] < 0 {
            std::mem::swap(&mut n1, &mut n2);
        }
        let diam = m.links[k].diam;
        let area = 0.25 * PI * diam * diam;
        let asquare = area * area;
        let firstseg = q.first_seg[k];
        let lastseg = q.last_seg[k];
        if firstseg == NIL {
            continue;
        }
        let fs = q.segs.meta[firstseg];
        let ls = q.segs.meta[lastseg];
        let coefirstseg = ld * asquare / fs.v;
        let coelastseg = ld * asquare / ls.v;
        let ndx = ds.ndx[k];
        ds.aij[ndx] -= coefirstseg * fs.uresponse;

        let src2 = source_for(m, n2, sp);
        if n2 <= njuncs {
            if src2.is_none_or(|s| s.c0 <= 0.0) {
                ds.aii[ds.row[n2]] += coefirstseg * (1.0 - fs.dresponse);
                ds.f[ds.row[n2]] += coefirstseg * fs.hresponse;
            } else {
                ds.aij[ndx] = 0.0;
                ds.f[ds.row[n1]] += coelastseg * ls.dresponse * q.node_c[n2][sp];
            }
        } else {
            ds.f[ds.row[n1]] += coelastseg * ls.dresponse * q.node_c[n2][sp];
        }

        if n1 <= njuncs {
            // As in the C code, the upstream test looks at the node's first source,
            // whatever its species.
            let src1 = m.nodes[n1].sources.first();
            if src1.is_none_or(|s| s.c0 <= 0.0) {
                ds.aii[ds.row[n1]] += coelastseg * (1.0 - ls.uresponse);
                ds.f[ds.row[n1]] += coelastseg * ls.hresponse;
            } else {
                ds.aij[ndx] = 0.0;
                ds.f[ds.row[n2]] += coefirstseg * fs.uresponse * q.node_c[n1][sp];
            }
        } else {
            ds.f[ds.row[n2]] += coefirstseg * fs.uresponse * q.node_c[n1][sp];
        }
    }
    for i in 1..=njuncs {
        let r = ds.row[i];
        if ds.aii[r] == 0.0 {
            ds.aii[r] = 1.0;
            ds.f[r] = 1.0 * q.node_c[i][sp];
        }
    }
    let _ = ds.linsolve(njuncs);
    for i in 1..=njuncs {
        q.node_c[i][sp] = ds.f[ds.row[i]];
    }
}

/// `segqual_update`: segment concentrations from the new end concentrations, and the
/// mass dispersed into the network.
pub fn segqual_update(q: &mut Qual, m: &Model, sp: usize, tstep: f64) {
    let njuncs = m.nobjects[NODE] - m.nobjects[TANK];
    let mut dispersedin = 0.0;
    for k in 1..=m.nobjects[LINK] {
        let ld = q.dispersion.pipe_dispersion_coeff[k];
        if ld <= 0.0 {
            continue;
        }
        let area = 0.25 * PI * m.links[k].diam * m.links[k].diam;
        let (mut n1, mut n2) = (m.links[k].n1, m.links[k].n2);
        if q.flow_dir[k] < 0 {
            std::mem::swap(&mut n1, &mut n2);
        }
        let mut seg = q.first_seg[k];
        while seg != NIL {
            let meta = q.segs.meta[seg];
            q.segs.c_mut(seg)[sp] = meta.hresponse
                + q.node_c[n2][sp] * meta.dresponse
                + q.node_c[n1][sp] * meta.uresponse;
            seg = q.segs.prev(seg);
        }
        let first = q.first_seg[k];
        if first == NIL {
            continue;
        }
        let tank_end = |n: usize| n > njuncs;
        let flux = |q: &Qual, n: usize, s: usize| {
            2.0 * ld * tstep * area * area * (q.node_c[n][sp] - q.segs.c(s)[sp]) * L_PER_FT3
                / q.segs.v(s)
        };
        let mut massin = 0.0;
        if source_for(m, n2, sp).is_some_and(|s| s.c0 > 0.0) || tank_end(n2) {
            massin = flux(q, n2, first);
        }
        dispersedin += massin;
        let last = q.last_seg[k];
        massin = 0.0;
        if source_for(m, n1, sp).is_some_and(|s| s.c0 > 0.0) || tank_end(n1) {
            massin = flux(q, n1, last);
        }
        dispersedin += massin;
    }
    q.mass.indisperse[sp] += dispersedin;
}
