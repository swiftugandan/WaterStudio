// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (smatrix.c), Copyright (c) 2019 OWA-EPANET
// authors. See LICENSES/OWA-EPANET.txt.

//! Sparse matrix set-up and the Cholesky solver for the hydraulic equations.
//!
//! EPANET keeps node adjacency as singly linked lists with new entries pushed at
//! the head. Here each list is a vector in insertion order and is walked in
//! reverse, which visits entries in exactly EPANET's order; the order decides the
//! fill-in pattern of the factor.

use crate::genmmd::genmmd;
use crate::types::{Network, Smatrix};

/// One adjacency entry: the node at the other end (0 marks a parallel link) and
/// the link or coefficient index.
#[derive(Clone, Copy, Debug)]
struct Adj {
    node: usize,
    link: usize,
}

/// `createsparse`: build the sparse structure of the solution matrix.
pub fn createsparse(net: &Network) -> Smatrix {
    let nnodes = net.nnodes;
    let nlinks = net.nlinks;
    let njuncs = net.njuncs;
    let mut sm = Smatrix {
        order: vec![0; nnodes + 1],
        row: vec![0; nnodes + 1],
        ndx: vec![0; nlinks + 1],
        ..Smatrix::default()
    };

    // localadjlists: adjacency lists with parallel links removed.
    let mut adj: Vec<Vec<Adj>> = vec![Vec::new(); nnodes + 1];
    for k in 1..=nlinks {
        let i = net.link[k].n1;
        let j = net.link[k].n2;
        // paralink
        let pmark = match adj[i].iter().rev().find(|a| a.node == j) {
            Some(a) => {
                sm.ndx[k] = a.link;
                true
            }
            None => {
                sm.ndx[k] = k;
                false
            }
        };
        adj[i].push(Adj {
            node: if pmark { 0 } else { j },
            link: k,
        });
        adj[j].push(Adj {
            node: if pmark { 0 } else { i },
            link: k,
        });
    }
    // xparalinks
    for list in adj.iter_mut() {
        list.retain(|a| a.node != 0);
    }

    reordernodes(&mut sm, &adj, nnodes, njuncs, nlinks);
    sm.ncoeffs = nlinks;
    factorize(&mut sm, &mut adj, nnodes, njuncs);
    storesparse(&mut sm, &adj, njuncs);
    sortsparse(&mut sm, njuncs);

    // EPANET assembles coefficient c at Aij[c] and reads it as Aij[LNZ[i]] while
    // factorising. Assembling it straight at its factor position i (where LNZ[i] == c)
    // gives the same values without the indirection. Coefficients no factor position
    // holds (links to tanks and reservoirs) are never assembled; they get a spare slot.
    let spare = sm.ncoeffs + 1;
    let mut pos = vec![spare; sm.ncoeffs + 2];
    for p in 1..sm.xlnz[njuncs + 1] {
        pos[sm.lnz[p]] = p;
    }
    for k in 1..=nlinks {
        sm.ndx[k] = pos[sm.ndx[k]];
    }

    // alloclinsolve
    sm.aij = vec![0.0; sm.ncoeffs + 2];
    sm.aii = vec![0.0; nnodes + 1];
    sm.f = vec![0.0; nnodes + 1];
    sm.temp = vec![0.0; nnodes + 1];
    sm.link = vec![0; nnodes + 1];
    sm.first = vec![0; nnodes + 1];
    sm
}

/// `reordernodes`: minimum degree ordering of the junctions.
fn reordernodes(sm: &mut Smatrix, adj: &[Vec<Adj>], nnodes: usize, njuncs: usize, nlinks: usize) {
    for k in 1..=nnodes {
        sm.row[k] = k;
        sm.order[k] = k;
    }
    let mut adjncy = vec![0i32; 2 * nlinks + 2];
    let mut xadj = vec![0i32; njuncs + 2];
    let mut dhead = vec![0i32; njuncs + 2];
    let mut qsize = vec![0i32; njuncs + 2];
    let mut llist = vec![0i32; njuncs + 2];
    let mut marker = vec![0i32; njuncs + 2];
    let mut invp = vec![0i32; nnodes + 1];
    let mut perm = vec![0i32; nnodes + 1];
    for k in 1..=nnodes {
        invp[k] = k as i32;
        perm[k] = k as i32;
    }
    xadj[1] = 1;
    let mut mm = 1usize;
    for k in 1..=njuncs {
        for a in adj[k].iter().rev() {
            if a.node > 0 && a.node <= njuncs {
                adjncy[mm] = a.node as i32;
                mm += 1;
            }
        }
        xadj[k + 1] = mm as i32;
    }
    genmmd(
        njuncs as i32,
        &mut xadj,
        &mut adjncy,
        &mut invp,
        &mut perm,
        -1,
        &mut dhead,
        &mut qsize,
        &mut llist,
        &mut marker,
        i32::MAX,
    );
    for k in 1..=njuncs {
        sm.row[k] = invp[k] as usize;
        sm.order[k] = perm[k] as usize;
    }
}

/// `factorize`, `growlist`, `newlink`: add fill-in connections.
fn factorize(sm: &mut Smatrix, adj: &mut [Vec<Adj>], nnodes: usize, njuncs: usize) {
    let mut degree = vec![0i32; nnodes + 1];
    for k in 1..=njuncs {
        degree[k] = adj[k].iter().filter(|a| a.node > 0).count() as i32;
    }
    // `linked(inode, jnode)` scans inode's list in EPANET; marking inode's neighbours once
    // per inode answers the same question in constant time (only inode's list grows
    // with inode's entries while it is checked).
    let mut mark = vec![0usize; nnodes + 1];
    let mut stamp = 0usize;
    for k in 1..=njuncs {
        let knode = sm.order[k];
        // growlist: knode's own list does not change while it is walked.
        let list = adj[knode].clone();
        for pos in (0..list.len()).rev() {
            let node = list[pos].node;
            if node > 0 && degree[node] > 0 {
                degree[node] -= 1;
                // newlink: scan the entries that follow `pos` in head-first order.
                let inode = node;
                stamp += 1;
                for a in &adj[inode] {
                    mark[a.node] = stamp;
                }
                for bpos in (0..pos).rev() {
                    let jnode = list[bpos].node;
                    if jnode > 0 && degree[jnode] > 0 && mark[jnode] != stamp {
                        mark[jnode] = stamp;
                        sm.ncoeffs += 1;
                        adj[inode].push(Adj {
                            node: jnode,
                            link: sm.ncoeffs,
                        });
                        adj[jnode].push(Adj {
                            node: inode,
                            link: sm.ncoeffs,
                        });
                        degree[inode] += 1;
                        degree[jnode] += 1;
                    }
                }
            }
        }
        degree[knode] = 0;
    }
}

/// `storesparse`: positions of the non-zero coefficients by column.
fn storesparse(sm: &mut Smatrix, adj: &[Vec<Adj>], n: usize) {
    sm.xlnz = vec![0; n + 2];
    sm.nzsub = vec![0; sm.ncoeffs + 2];
    sm.lnz = vec![0; sm.ncoeffs + 2];
    let mut k = 0;
    sm.xlnz[1] = 1;
    for i in 1..=n {
        let mut m = 0;
        let ii = sm.order[i];
        for a in adj[ii].iter().rev() {
            if a.node == 0 {
                continue;
            }
            let j = sm.row[a.node];
            if j > i && j <= n {
                m += 1;
                k += 1;
                sm.nzsub[k] = j;
                sm.lnz[k] = a.link;
            }
        }
        sm.xlnz[i + 1] = sm.xlnz[i] + m;
    }
}

/// `sortsparse`: order row indexes within each column (transpose twice).
fn sortsparse(sm: &mut Smatrix, n: usize) {
    let mut xlnzt = vec![0usize; n + 2];
    let mut nzsubt = vec![0usize; sm.ncoeffs + 2];
    let mut lnzt = vec![0usize; sm.ncoeffs + 2];
    let mut nzt = vec![0usize; n + 2];
    for i in 1..=n {
        for k in sm.xlnz[i]..sm.xlnz[i + 1] {
            nzt[sm.nzsub[k]] += 1;
        }
    }
    xlnzt[1] = 1;
    for i in 1..=n {
        xlnzt[i + 1] = xlnzt[i] + nzt[i];
    }
    transpose(
        n,
        &sm.xlnz,
        &sm.nzsub,
        &sm.lnz,
        &xlnzt,
        &mut nzsubt,
        &mut lnzt,
        &mut nzt,
    );
    let (xlnz, mut nzsub, mut lnz) = (
        sm.xlnz.clone(),
        vec![0; sm.ncoeffs + 2],
        vec![0; sm.ncoeffs + 2],
    );
    transpose(
        n, &xlnzt, &nzsubt, &lnzt, &xlnz, &mut nzsub, &mut lnz, &mut nzt,
    );
    sm.nzsub = nzsub;
    sm.lnz = lnz;
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
    for v in nzt.iter_mut().take(n + 1).skip(1) {
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

/// `linsolve`: solve the symmetric positive definite system by Cholesky
/// factorisation. The solution replaces `F`. Returns the 1-based row where the
/// matrix stopped being positive definite, or 0 on success.
pub fn linsolve(sm: &mut Smatrix, n: usize) -> usize {
    // Coefficients are assembled at their factor positions (see `createsparse`), so
    // EPANET's Aij[LNZ[i]] is aij[i] here; the arithmetic and its order are EPANET's.
    let Smatrix {
        aii,
        aij,
        f: b,
        temp,
        xlnz,
        nzsub,
        link,
        first,
        ..
    } = sm;
    for i in 0..=n {
        temp[i] = 0.0;
        link[i] = 0;
        first[i] = 0;
    }
    // Numerical factorisation: compute column L(*,j) for j = 1..n.
    for j in 1..=n {
        let mut diagj = 0.0;
        let mut newk = link[j];
        let mut k = newk;
        while k != 0 {
            newk = link[k];
            let kfirst = first[k];
            let ljk = aij[kfirst];
            diagj += ljk * ljk;
            let istrt = kfirst + 1;
            let istop = xlnz[k + 1] - 1;
            if istop >= istrt {
                first[k] = istrt;
                let isub = nzsub[istrt];
                link[k] = link[isub];
                link[isub] = k;
                for (&isub, &l) in nzsub[istrt..=istop].iter().zip(&aij[istrt..=istop]) {
                    temp[isub] += l * ljk;
                }
            }
            k = newk;
        }
        let mut diag = aii[j] - diagj;
        if diag <= 0.0 {
            return j;
        }
        diag = crate::types::sqrt(diag);
        aii[j] = diag;
        let istrt = xlnz[j];
        let istop = xlnz[j + 1] - 1;
        if istop >= istrt {
            first[j] = istrt;
            let isub = nzsub[istrt];
            link[j] = link[isub];
            link[isub] = j;
            for (&isub, l) in nzsub[istrt..=istop].iter().zip(&mut aij[istrt..=istop]) {
                *l = (*l - temp[isub]) / diag;
                temp[isub] = 0.0;
            }
        }
    }
    // Forward substitution.
    for j in 1..=n {
        let bj = b[j] / aii[j];
        b[j] = bj;
        let istrt = xlnz[j];
        let istop = xlnz[j + 1] - 1;
        if istop >= istrt {
            for (&isub, &l) in nzsub[istrt..=istop].iter().zip(&aij[istrt..=istop]) {
                b[isub] -= l * bj;
            }
        }
    }
    // Backward substitution.
    for j in (1..=n).rev() {
        let mut bj = b[j];
        let istrt = xlnz[j];
        let istop = xlnz[j + 1] - 1;
        if istop >= istrt {
            for (&isub, &l) in nzsub[istrt..=istop].iter().zip(&aij[istrt..=istop]) {
                bj -= l * b[isub];
            }
        }
        b[j] = bj / aii[j];
    }
    0
}
