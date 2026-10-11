// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (genmmd.c): Joseph W.H. Liu's multiple minimum
// external degree ordering (SPARSPAK), translated from Fortran by f2c and adapted
// for EPANET. Copyright (c) 2019 OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.
//
// The Fortran control flow (labels and gotos) is kept as explicit state machines
// whose states carry the original label numbers, so each transfer can be checked
// against genmmd.c. All arrays are 1-based; entry 0 is unused.

/// Multiple minimum degree ordering.
///
/// `xadj` and `adjncy` are the adjacency structure (destroyed). On return,
/// `perm[k]` is the node ordered k-th and `invp[node]` its position.
#[allow(clippy::too_many_arguments)]
pub fn genmmd(
    neqns: i32,
    xadj: &mut [i32],
    adjncy: &mut [i32],
    invp: &mut [i32],
    perm: &mut [i32],
    delta: i32,
    dhead: &mut [i32],
    qsize: &mut [i32],
    llist: &mut [i32],
    marker: &mut [i32],
    maxint: i32,
) -> i32 {
    if neqns <= 0 {
        return 0;
    }
    let mut nofsub = 0;
    mmdint(neqns, xadj, dhead, invp, perm, qsize, llist, marker);
    let mut num = 1;

    // Eliminate all isolated nodes (L100).
    let mut nextmd = dhead[1];
    while nextmd > 0 {
        let mdnode = nextmd;
        nextmd = invp[mdnode as usize];
        marker[mdnode as usize] = maxint;
        invp[mdnode as usize] = -num;
        num += 1;
    }

    #[derive(Clone, Copy)]
    enum L {
        L200,
        L300,
        L400,
        L500,
        L600,
        L800,
        L900,
        L1000,
    }
    let mut tag = 0;
    let mut mdeg = 0;
    let mut mdlmt = 0;
    let mut ehead = 0;
    let mut mdnode = 0;
    let mut state = L::L200;
    loop {
        state = match state {
            L::L200 => {
                if num > neqns {
                    L::L1000
                } else {
                    tag = 1;
                    dhead[1] = 0;
                    mdeg = 2;
                    L::L300
                }
            }
            L::L300 => {
                if dhead[mdeg as usize] > 0 {
                    L::L400
                } else {
                    mdeg += 1;
                    L::L300
                }
            }
            L::L400 => {
                mdlmt = mdeg + delta;
                ehead = 0;
                L::L500
            }
            L::L500 => {
                mdnode = dhead[mdeg as usize];
                if mdnode > 0 {
                    L::L600
                } else {
                    mdeg += 1;
                    if mdeg > mdlmt { L::L900 } else { L::L500 }
                }
            }
            L::L600 => {
                let md = mdnode as usize;
                nextmd = invp[md];
                dhead[mdeg as usize] = nextmd;
                if nextmd > 0 {
                    perm[nextmd as usize] = -mdeg;
                }
                invp[md] = -num;
                nofsub = nofsub + mdeg + qsize[md] - 2;
                if num + qsize[md] > neqns {
                    L::L1000
                } else {
                    tag += 1;
                    if tag >= maxint {
                        tag = 1;
                        for i in 1..=neqns as usize {
                            if marker[i] < maxint {
                                marker[i] = 0;
                            }
                        }
                    }
                    L::L800
                }
            }
            L::L800 => {
                mmdelm(
                    mdnode, xadj, adjncy, dhead, invp, perm, qsize, llist, marker, maxint, tag,
                );
                num += qsize[mdnode as usize];
                llist[mdnode as usize] = ehead;
                ehead = mdnode;
                if delta >= 0 { L::L500 } else { L::L900 }
            }
            L::L900 => {
                if num > neqns {
                    L::L1000
                } else {
                    mmdupd(
                        ehead, neqns, xadj, adjncy, delta, &mut mdeg, dhead, invp, perm, qsize,
                        llist, marker, maxint, &mut tag,
                    );
                    L::L300
                }
            }
            L::L1000 => {
                mmdnum(neqns, perm, invp, qsize);
                return nofsub;
            }
        };
    }
}

/// MMDINT: initialisation.
#[allow(clippy::too_many_arguments)]
fn mmdint(
    neqns: i32,
    xadj: &[i32],
    dhead: &mut [i32],
    dforw: &mut [i32],
    dbakw: &mut [i32],
    qsize: &mut [i32],
    llist: &mut [i32],
    marker: &mut [i32],
) {
    for node in 1..=neqns as usize {
        dhead[node] = 0;
        qsize[node] = 1;
        marker[node] = 0;
        llist[node] = 0;
    }
    for node in 1..=neqns as usize {
        let ndeg = (xadj[node + 1] - xadj[node] + 1) as usize;
        let fnode = dhead[ndeg];
        dforw[node] = fnode;
        dhead[ndeg] = node as i32;
        if fnode > 0 {
            dbakw[fnode as usize] = node as i32;
        }
        dbakw[node] = -(ndeg as i32);
    }
}

/// MMDELM: eliminate `mdnode` and transform the quotient graph.
#[allow(clippy::too_many_arguments)]
fn mmdelm(
    mdnode: i32,
    xadj: &[i32],
    adjncy: &mut [i32],
    dhead: &mut [i32],
    dforw: &mut [i32],
    dbakw: &mut [i32],
    qsize: &mut [i32],
    llist: &mut [i32],
    marker: &mut [i32],
    maxint: i32,
    tag: i32,
) {
    let md = mdnode as usize;
    marker[md] = tag;
    let istrt = xadj[md];
    let istop = xadj[md + 1] - 1;
    // Find the reachable set and place it in the data structure.
    let mut elmnt = 0;
    let mut rloc = istrt;
    let mut rlmt = istop;
    let mut i = istrt;
    while i <= istop {
        let nabor = adjncy[i as usize];
        if nabor == 0 {
            break; // goto L300
        }
        if marker[nabor as usize] < tag {
            marker[nabor as usize] = tag;
            if dforw[nabor as usize] < 0 {
                llist[nabor as usize] = elmnt;
                elmnt = nabor;
            } else {
                adjncy[rloc as usize] = nabor;
                rloc += 1;
            }
        }
        i += 1;
    }
    // L300: merge with reachable nodes from generalized elements.
    while elmnt > 0 {
        adjncy[rlmt as usize] = -elmnt;
        let mut link = elmnt;
        // L400
        'l400: loop {
            let jstrt = xadj[link as usize];
            let jstop = xadj[link as usize + 1] - 1;
            let mut j = jstrt;
            while j <= jstop {
                let node = adjncy[j as usize];
                link = -node;
                if node < 0 {
                    continue 'l400;
                } else if node == 0 {
                    break 'l400; // goto L900
                }
                // L500
                if !(marker[node as usize] >= tag || dforw[node as usize] < 0) {
                    marker[node as usize] = tag;
                    // L600: use storage from eliminated nodes if necessary.
                    while rloc >= rlmt {
                        let lk = -adjncy[rlmt as usize];
                        rloc = xadj[lk as usize];
                        rlmt = xadj[lk as usize + 1] - 1;
                    }
                    // L700
                    adjncy[rloc as usize] = node;
                    rloc += 1;
                }
                // L800
                j += 1;
            }
            break 'l400;
        }
        // L900
        elmnt = llist[elmnt as usize];
    }
    // L1000
    if rloc <= rlmt {
        adjncy[rloc as usize] = 0;
    }
    // For each node in the reachable set...
    let mut link = mdnode;
    'l1100: loop {
        let istrt = xadj[link as usize];
        let istop = xadj[link as usize + 1] - 1;
        let mut i = istrt;
        while i <= istop {
            let rnode = adjncy[i as usize];
            link = -rnode;
            if rnode < 0 {
                continue 'l1100;
            } else if rnode == 0 {
                return; // L1800
            }
            let rn = rnode as usize;
            // L1200: if rnode is in the degree list structure, remove it.
            let pvnode = dbakw[rn];
            if !(pvnode == 0 || pvnode == -maxint) {
                let nxnode = dforw[rn];
                if nxnode > 0 {
                    dbakw[nxnode as usize] = pvnode;
                }
                if pvnode > 0 {
                    dforw[pvnode as usize] = nxnode;
                }
                let npv = -pvnode;
                if pvnode < 0 {
                    dhead[npv as usize] = nxnode;
                }
            }
            // L1300: purge inactive quotient neighbours of rnode.
            let jstrt = xadj[rn];
            let jstop = xadj[rn + 1] - 1;
            let mut xqnbr = jstrt;
            let mut j = jstrt;
            while j <= jstop {
                let nabor = adjncy[j as usize];
                if nabor == 0 {
                    break; // L1500
                }
                if marker[nabor as usize] < tag {
                    adjncy[xqnbr as usize] = nabor;
                    xqnbr += 1;
                }
                j += 1;
            }
            // L1500
            let nqnbrs = xqnbr - jstrt;
            if nqnbrs > 0 {
                // L1600
                dforw[rn] = nqnbrs + 1;
                dbakw[rn] = 0;
                adjncy[xqnbr as usize] = mdnode;
                xqnbr += 1;
                if xqnbr <= jstop {
                    adjncy[xqnbr as usize] = 0;
                }
            } else {
                // rnode is indistinguishable from mdnode: merge them.
                qsize[md] += qsize[rn];
                qsize[rn] = 0;
                marker[rn] = maxint;
                dforw[rn] = -mdnode;
                dbakw[rn] = -maxint;
            }
            // L1700
            i += 1;
        }
        return; // L1800
    }
}

/// MMDUPD: update degrees of nodes affected by the eliminations.
#[allow(clippy::too_many_arguments)]
fn mmdupd(
    ehead: i32,
    neqns: i32,
    xadj: &[i32],
    adjncy: &[i32],
    delta: i32,
    mdeg: &mut i32,
    dhead: &mut [i32],
    dforw: &mut [i32],
    dbakw: &mut [i32],
    qsize: &mut [i32],
    llist: &mut [i32],
    marker: &mut [i32],
    maxint: i32,
    tag: &mut i32,
) {
    let mdeg0 = *mdeg + delta;
    let mut elmnt = ehead;
    // L100
    while elmnt > 0 {
        let mut mtag = *tag + mdeg0;
        if mtag >= maxint {
            *tag = 1;
            for i in 1..=neqns as usize {
                if marker[i] < maxint {
                    marker[i] = 0;
                }
            }
            mtag = *tag + mdeg0;
        }
        // L300: build q2 (nodes with two neighbours) and qx lists.
        let mut q2head = 0;
        let mut qxhead = 0;
        let mut deg0 = 0;
        let mut link = elmnt;
        'l400: loop {
            let istrt = xadj[link as usize];
            let istop = xadj[link as usize + 1] - 1;
            let mut i = istrt;
            while i <= istop {
                let enode = adjncy[i as usize];
                link = -enode;
                if enode < 0 {
                    continue 'l400;
                } else if enode == 0 {
                    break 'l400; // L800
                }
                let en = enode as usize;
                // L500
                if qsize[en] != 0 {
                    deg0 += qsize[en];
                    marker[en] = mtag;
                    if dbakw[en] == 0 {
                        if dforw[en] == 2 {
                            // L600
                            llist[en] = q2head;
                            q2head = enode;
                        } else {
                            llist[en] = qxhead;
                            qxhead = enode;
                        }
                    }
                }
                // L700
                i += 1;
            }
            break 'l400;
        }
        // L800: process q2 nodes first (iq2 = 1), then qx nodes (iq2 = 0).
        #[derive(Clone, Copy, PartialEq)]
        enum S {
            L900,
            L1500,
            L1600,
            L2100,
            L2200,
            L2300,
        }
        let mut enode = q2head;
        let mut iq2 = 1;
        let mut deg = 0;
        let mut state = S::L900;
        loop {
            state = match state {
                S::L900 => {
                    if enode <= 0 {
                        S::L1500
                    } else if dbakw[enode as usize] != 0 {
                        S::L2200
                    } else {
                        *tag += 1;
                        deg = deg0;
                        // Identify the other adjacent element neighbour.
                        let istrt = xadj[enode as usize];
                        let mut nabor = adjncy[istrt as usize];
                        if nabor == elmnt {
                            nabor = adjncy[istrt as usize + 1];
                        }
                        let mut link = nabor;
                        if dforw[nabor as usize] >= 0 {
                            // nabor is uneliminated: increase degree count.
                            deg += qsize[nabor as usize];
                            S::L2100
                        } else {
                            // L1000: nabor is eliminated; for each node in its boundary...
                            'l1000: loop {
                                let istrt = xadj[link as usize];
                                let istop = xadj[link as usize + 1] - 1;
                                let mut i = istrt;
                                while i <= istop {
                                    let node = adjncy[i as usize];
                                    link = -node;
                                    if node != enode {
                                        if node < 0 {
                                            continue 'l1000;
                                        } else if node == 0 {
                                            break 'l1000; // L2100
                                        }
                                        let nd = node as usize;
                                        // L1100
                                        if qsize[nd] != 0 {
                                            if marker[nd] < *tag {
                                                marker[nd] = *tag;
                                                deg += qsize[nd];
                                            } else if dbakw[nd] == 0 {
                                                // L1200
                                                if dforw[nd] == 2 {
                                                    qsize[enode as usize] += qsize[nd];
                                                    qsize[nd] = 0;
                                                    marker[nd] = maxint;
                                                    dforw[nd] = -enode;
                                                    dbakw[nd] = -maxint;
                                                } else if dbakw[nd] == 0 {
                                                    // L1300
                                                    dbakw[nd] = -maxint;
                                                }
                                            }
                                        }
                                    }
                                    // L1400
                                    i += 1;
                                }
                                break 'l1000;
                            }
                            S::L2100
                        }
                    }
                }
                S::L1500 => {
                    enode = qxhead;
                    iq2 = 0;
                    S::L1600
                }
                S::L1600 => {
                    if enode <= 0 {
                        S::L2300
                    } else if dbakw[enode as usize] != 0 {
                        S::L2200
                    } else {
                        *tag += 1;
                        deg = deg0;
                        let istrt = xadj[enode as usize];
                        let istop = xadj[enode as usize + 1] - 1;
                        let mut i = istrt;
                        while i <= istop {
                            let nabor = adjncy[i as usize];
                            if nabor == 0 {
                                break; // L2100
                            }
                            let nb = nabor as usize;
                            if marker[nb] < *tag {
                                marker[nb] = *tag;
                                let mut link = nabor;
                                if dforw[nb] >= 0 {
                                    deg += qsize[nb];
                                } else {
                                    // L1700
                                    'l1700: loop {
                                        let jstrt = xadj[link as usize];
                                        let jstop = xadj[link as usize + 1] - 1;
                                        let mut j = jstrt;
                                        while j <= jstop {
                                            let node = adjncy[j as usize];
                                            link = -node;
                                            if node < 0 {
                                                continue 'l1700;
                                            } else if node == 0 {
                                                break 'l1700; // L2000
                                            }
                                            // L1800
                                            let nd = node as usize;
                                            if marker[nd] < *tag {
                                                marker[nd] = *tag;
                                                deg += qsize[nd];
                                            }
                                            // L1900
                                            j += 1;
                                        }
                                        break 'l1700;
                                    }
                                }
                            }
                            // L2000
                            i += 1;
                        }
                        S::L2100
                    }
                }
                S::L2100 => {
                    // Update external degree of enode in the degree structure.
                    let en = enode as usize;
                    deg = deg - qsize[en] + 1;
                    let fnode = dhead[deg as usize];
                    dforw[en] = fnode;
                    dbakw[en] = -deg;
                    if fnode > 0 {
                        dbakw[fnode as usize] = enode;
                    }
                    dhead[deg as usize] = enode;
                    if deg < *mdeg {
                        *mdeg = deg;
                    }
                    S::L2200
                }
                S::L2200 => {
                    // Get next enode in current element.
                    enode = llist[enode as usize];
                    if iq2 == 1 { S::L900 } else { S::L1600 }
                }
                S::L2300 => break,
            };
        }
        // L2300: get next element in the list.
        *tag = mtag;
        elmnt = llist[elmnt as usize];
    }
}

/// MMDNUM: final numbering of the permutation.
fn mmdnum(neqns: i32, perm: &mut [i32], invp: &mut [i32], qsize: &[i32]) {
    for node in 1..=neqns as usize {
        let nqsize = qsize[node];
        if nqsize <= 0 {
            perm[node] = invp[node];
        }
        if nqsize > 0 {
            perm[node] = -invp[node];
        }
    }
    // For each node which has been merged, find its root.
    for node in 1..=neqns as usize {
        if perm[node] > 0 {
            continue; // L500
        }
        let mut father = node;
        // L200
        while perm[father] <= 0 {
            father = (-perm[father]) as usize;
        }
        // L300
        let root = father;
        let num = perm[root] + 1;
        invp[node] = -num;
        perm[root] = num;
        // L400: shorten the merged tree.
        father = node;
        loop {
            let nextf = -perm[father];
            if nextf <= 0 {
                break;
            }
            perm[father] = -(root as i32);
            father = nextf as usize;
        }
    }
    // Ready to compute perm.
    for node in 1..=neqns as usize {
        let num = -invp[node];
        invp[node] = num;
        perm[num as usize] = node as i32;
    }
}
