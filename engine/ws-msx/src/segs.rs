// SPDX-License-Identifier: MIT
// Derived from EPANET-MSX 2.0 (msxqual.c). See LICENSES/EPANET-MSX.txt.

//! Water quality segments (`Sseg`) in an arena. Links of the C code's doubly linked
//! lists become indices; `NIL` is the null pointer. A pipe's first segment is the
//! most downstream one and `prev` points upstream, as in msxqual.c.

pub const NIL: usize = usize::MAX;

#[derive(Clone, Copy, Debug, Default)]
pub struct SegMeta {
    pub hstep: f64,
    pub v: f64,
    pub prev: usize,
    pub next: usize,
    pub hresponse: f64,
    pub uresponse: f64,
    pub dresponse: f64,
}

/// All segments ever allocated, with a free list threaded through `prev`.
#[derive(Clone, Debug, Default)]
pub struct Segs {
    stride: usize,
    pub meta: Vec<SegMeta>,
    c: Vec<f64>,
    lastc: Vec<f64>,
    pub free: usize,
}

impl Segs {
    pub fn new(nsp: usize) -> Segs {
        Segs {
            stride: nsp + 1,
            meta: Vec::new(),
            c: Vec::new(),
            lastc: Vec::new(),
            free: NIL,
        }
    }

    /// `AllocReset`: forget every segment.
    pub fn reset(&mut self) {
        self.meta.clear();
        self.c.clear();
        self.lastc.clear();
        self.free = NIL;
    }

    #[inline(always)]
    pub fn c(&self, s: usize) -> &[f64] {
        &self.c[s * self.stride..(s + 1) * self.stride]
    }

    #[inline(always)]
    pub fn c_mut(&mut self, s: usize) -> &mut [f64] {
        &mut self.c[s * self.stride..(s + 1) * self.stride]
    }

    /// The concentrations and the previous step's concentrations of a segment.
    #[inline(always)]
    pub fn c_and_lastc(&mut self, s: usize) -> (&mut [f64], &mut [f64]) {
        let r = s * self.stride..(s + 1) * self.stride;
        (&mut self.c[r.clone()], &mut self.lastc[r])
    }

    #[inline(always)]
    pub fn v(&self, s: usize) -> f64 {
        self.meta[s].v
    }

    #[inline(always)]
    pub fn prev(&self, s: usize) -> usize {
        self.meta[s].prev
    }

    #[inline(always)]
    pub fn next(&self, s: usize) -> usize {
        self.meta[s].next
    }

    /// `MSXqual_getFreeSeg`
    pub fn get_free_seg(&mut self, v: f64, c: &[f64]) -> usize {
        let s = if self.free != NIL {
            let s = self.free;
            self.free = self.meta[s].prev;
            s
        } else {
            let s = self.meta.len();
            self.meta.push(SegMeta {
                prev: NIL,
                next: NIL,
                ..SegMeta::default()
            });
            self.c.resize(self.c.len() + self.stride, 0.0);
            self.lastc.resize(self.lastc.len() + self.stride, 0.0);
            s
        };
        self.meta[s].v = v;
        let stride = self.stride;
        self.c_mut(s)[1..stride].copy_from_slice(&c[1..stride]);
        self.meta[s].hstep = 0.0;
        s
    }

    /// `MSXqual_removeSeg`
    pub fn remove_seg(&mut self, s: usize) {
        if s == NIL {
            return;
        }
        self.meta[s].prev = self.free;
        self.meta[s].next = NIL;
        self.free = s;
    }
}
