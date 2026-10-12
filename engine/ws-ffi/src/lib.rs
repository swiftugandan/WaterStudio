// SPDX-License-Identifier: MIT
// The API is OWA-EPANET 2.3's (epanet2_2.h), Copyright (c) 2019 OWA-EPANET authors.
// See LICENSES/OWA-EPANET.txt.

//! `libepanet2`: EPANET 2.3's C toolkit API over WaterStudio's engine.
//!
//! Programs written for OWA-EPANET compile against its `epanet2_2.h` (shipped in
//! `include/`) and link against this library instead. Every function forwards to
//! [`ws_solver::epanet::Toolkit`], which ports `epanet.c` line by line; this crate only
//! moves values across the C boundary. `oracle/toolkit.sh` runs one C program against
//! both libraries and requires identical output.
//!
//! With `ws-wasm`, this is the only crate allowed `unsafe`, and only here: raw pointers
//! from C are checked for null and never kept.

#![allow(unsafe_code)]
#![allow(clippy::missing_safety_doc)]

use std::ffi::{CStr, CString, c_char, c_double, c_int, c_long, c_void};
use std::io::Write;
use ws_solver::epanet::{self, MAXID, MAXMSG, ReportOutput, TITLELEN, Toolkit};

pub mod legacy;

/// The report callback of `EN_setreportcallback`: (user data, project, line).
pub type ReportCallback = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char);

/// What an `EN_Project` points at: the toolkit and the caller's report callback.
pub struct Handle {
    tk: Toolkit,
    callback: Option<ReportCallback>,
    user_data: *mut c_void,
}

impl Handle {
    /// Deliver the report written so far: to standard output or the callback (a
    /// report file is written by the toolkit).
    fn flush(&mut self) {
        match self.tk.flush_report() {
            ReportOutput::Nothing => {}
            ReportOutput::Stdout(text) => {
                let mut out = std::io::stdout();
                let _ = out.write_all(text.as_bytes());
                let _ = out.flush();
            }
            ReportOutput::Lines(lines) => {
                if let Some(cb) = self.callback {
                    let me = (self as *mut Handle).cast::<c_void>();
                    for line in lines {
                        let line = CString::new(line.replace('\0', " ")).unwrap_or_default();
                        // SAFETY: the caller registered this callback for this project.
                        unsafe { cb(self.user_data, me, line.as_ptr()) };
                    }
                }
            }
        }
    }
}

/// `EN_Project`: an opaque pointer to a project.
pub type EnProject = *mut Handle;

/// The project behind a handle, or None for a null handle.
unsafe fn tk<'a>(p: EnProject) -> Option<&'a mut Handle> {
    // SAFETY: a non-null handle comes from EN_createproject and stays valid until
    // EN_deleteproject; the caller must not use it concurrently, as with EPANET.
    unsafe { p.as_mut() }
}

/// A C string argument (lossy UTF-8), or None for a null pointer.
unsafe fn arg(s: *const c_char) -> Option<String> {
    if s.is_null() {
        return None;
    }
    // SAFETY: the caller passes a NUL-terminated string.
    Some(unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned())
}

/// Copy at most `max` bytes of `s` and a NUL into a caller's buffer (`strncpy`, but
/// always terminated, as EPANET's `strcpy` of a shorter string is).
unsafe fn put(dst: *mut c_char, s: &str, max: usize) {
    if dst.is_null() {
        return;
    }
    let bytes = s.as_bytes();
    let n = bytes.len().min(max);
    // SAFETY: the caller's buffer holds at least max + 1 bytes (EPANET's contract:
    // MAXID + 1 for IDs, MAXMSG + 1 for messages and comments).
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst.cast::<u8>(), n);
        *dst.add(n) = 0;
    }
}

/// Write through an output pointer, ignoring null.
unsafe fn out<T>(dst: *mut T, v: T) {
    // SAFETY: a non-null output pointer points at a T the caller owns.
    if let Some(d) = unsafe { dst.as_mut() } {
        *d = v;
    }
}

/// Run a toolkit call on a handle, then deliver what it wrote to the report; a null
/// handle is error 102 (no network data).
macro_rules! with {
    ($p:expr, $t:ident => $body:expr) => {{
        // SAFETY: see `tk`.
        match unsafe { tk($p) } {
            Some(h) => {
                #[allow(clippy::redundant_closure_call)]
                let r: c_int = (|| {
                    let $t: &mut Toolkit = &mut h.tk;
                    $body
                })();
                h.flush();
                r
            }
            None => 102,
        }
    }};
}

// ---- Project -------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_createproject(p: *mut EnProject) -> c_int {
    if p.is_null() {
        return -1;
    }
    let ph = Box::into_raw(Box::new(Handle {
        tk: Toolkit::new(),
        callback: None,
        user_data: std::ptr::null_mut(),
    }));
    // SAFETY: p is non-null and points at the caller's EN_Project.
    unsafe { *p = ph };
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_deleteproject(p: EnProject) -> c_int {
    if p.is_null() {
        return -1;
    }
    // SAFETY: p came from EN_createproject and is not used again.
    let mut h = unsafe { Box::from_raw(p) };
    h.flush();
    h.tk.close();
    drop(h);
    0
}

/// `strcomp`: case-insensitive comparison of file names.
fn same_name(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// `openfiles`' checks on the file names.
fn check_files(inp: &str, rpt: &str, outf: &str) -> c_int {
    if !inp.is_empty() && (same_name(inp, rpt) || same_name(inp, outf)) {
        return 301;
    }
    if !outf.is_empty() && same_name(rpt, outf) {
        return 301;
    }
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_open(
    p: EnProject,
    inp_file: *const c_char,
    rpt_file: *const c_char,
    out_file: *const c_char,
) -> c_int {
    // SAFETY: see `arg`.
    let (inp, rpt, outf) = unsafe { (arg(inp_file), arg(rpt_file), arg(out_file)) };
    let date = ctime_now();
    with!(p, t => t.open_files(&inp.unwrap_or_default(), &rpt.unwrap_or_default(), &outf.unwrap_or_default(), &date))
}

/// `EN_init`
#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_init(
    p: EnProject,
    rpt_file: *const c_char,
    out_file: *const c_char,
    units_type: c_int,
    head_loss_type: c_int,
) -> c_int {
    // SAFETY: see `arg`.
    let (rpt, outf) = unsafe { (arg(rpt_file), arg(out_file)) };
    let date = ctime_now();
    with!(p, t => t.init(&rpt.unwrap_or_default(), &outf.unwrap_or_default(), units_type, head_loss_type, &date))
}

/// The current time as C's `ctime` prints it (UTC), without the newline.
fn ctime_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MO: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {} {d:2} {:02}:{:02}:{:02} {y}",
        WD[days.rem_euclid(7) as usize],
        MO[((m - 1) as usize).min(11)],
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// `EN_runproject`: a whole run writing EPANET's report and binary output file, as
/// `runepanet` does (`ws run`). The progress callback is not called.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_runproject(
    p: EnProject,
    inp_file: *const c_char,
    rpt_file: *const c_char,
    out_file: *const c_char,
    _pviewprog: Option<unsafe extern "C" fn(*mut c_char)>,
) -> c_int {
    // SAFETY: see `arg`.
    let (inp, rpt, outf) = unsafe { (arg(inp_file), arg(rpt_file), arg(out_file)) };
    with!(p, t => {
        t.close();
        let (inp, rpt, outf) = (inp.unwrap_or_default(), rpt.unwrap_or_default(), outf.unwrap_or_default());
        let e = check_files(&inp, &rpt, &outf);
        if e != 0 {
            return e;
        }
        let Ok(bytes) = std::fs::read(&inp) else { return 302 };
        let r = ws_io::read_inp(&String::from_utf8_lossy(&bytes));
        if r.errors().next().is_some() {
            return 200;
        }
        let opts = ws_solver::RunOptions {
            inp_name: inp.clone(),
            date: ctime_now(),
            report: !rpt.is_empty(),
            status_log: false,
        };
        let run = match ws_solver::run_epanet(&r.model, &opts, |_| {}) {
            Ok(run) => run,
            Err(e) => return e.code,
        };
        if let Some(text) = run.report()
            && std::fs::write(&rpt, text).is_err()
        {
            return 303;
        }
        if !outf.is_empty() && std::fs::write(&outf, run.out_file()).is_err() {
            return 304;
        }
        run.warning()
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_close(p: EnProject) -> c_int {
    with!(p, t => t.close())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_gettitle(
    p: EnProject,
    line1: *mut c_char,
    line2: *mut c_char,
    line3: *mut c_char,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b, mut c) = (String::new(), String::new(), String::new());
        let e = t.gettitle(&mut a, &mut b, &mut c);
        if e == 0 {
            // SAFETY: title buffers hold TITLELEN + 1 bytes.
            unsafe {
                put(line1, &a, TITLELEN);
                put(line2, &b, TITLELEN);
                put(line3, &c, TITLELEN);
            }
        }
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getcomment(
    p: EnProject,
    object: c_int,
    index: c_int,
    comment: *mut c_char,
) -> c_int {
    with!(p, t => {
        let mut s = String::new();
        let e = t.getcomment(object, index, &mut s);
        // SAFETY: comment buffers hold MAXMSG + 1 bytes.
        unsafe { put(comment, &s, MAXMSG) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_gettag(
    p: EnProject,
    object: c_int,
    index: c_int,
    tag: *mut c_char,
) -> c_int {
    with!(p, t => {
        let mut s = String::new();
        let e = t.gettag(object, index, &mut s);
        // SAFETY: tag buffers hold MAXMSG + 1 bytes.
        unsafe { put(tag, &s, MAXMSG) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getcount(p: EnProject, object: c_int, count: *mut c_int) -> c_int {
    with!(p, t => {
        let mut v = 0;
        let e = t.getcount(object, &mut v);
        // SAFETY: see `out`.
        unsafe { out(count, v) };
        e
    })
}

// ---- Hydraulic and quality analysis -------------------------------------------------

macro_rules! simple {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject) -> c_int {
            with!(p, t => t.$method())
        }
    };
    ($name:ident, $method:ident, int) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, flag: c_int) -> c_int {
            with!(p, t => t.$method(flag))
        }
    };
    ($name:ident, $method:ident, long) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, value: *mut c_long) -> c_int {
            with!(p, t => {
                let mut v = 0i64;
                let e = t.$method(&mut v);
                // SAFETY: see `out`.
                unsafe { out(value, v as c_long) };
                e
            })
        }
    };
}

simple!(EN_solveH, solve_h);
simple!(EN_openH, open_h);
simple!(EN_initH, init_h, int);
simple!(EN_runH, run_h, long);
simple!(EN_nextH, next_h, long);
simple!(EN_closeH, close_h);
simple!(EN_solveQ, solve_q);
simple!(EN_openQ, open_q);
simple!(EN_initQ, init_q, int);
simple!(EN_runQ, run_q, long);
simple!(EN_nextQ, next_q, long);
simple!(EN_stepQ, step_q, long);
simple!(EN_closeQ, close_q);

// ---- Reporting and statistics --------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getversion(version: *mut c_int) -> c_int {
    let mut v = 0;
    let e = epanet::getversion(&mut v);
    // SAFETY: see `out`.
    unsafe { out(version, v) };
    e
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_geterror(errcode: c_int, errmsg: *mut c_char, max_len: c_int) -> c_int {
    let mut s = String::new();
    let e = epanet::geterror(errcode, &mut s, max_len);
    // SAFETY: errmsg holds max_len + 1 bytes (EPANET's contract).
    unsafe { put(errmsg, &s, max_len.max(0) as usize) };
    e
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getstatistic(p: EnProject, kind: c_int, value: *mut c_double) -> c_int {
    with!(p, t => {
        let mut v = 0.0;
        let e = t.getstatistic(kind, &mut v);
        // SAFETY: see `out`.
        unsafe { out(value, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getresultindex(
    p: EnProject,
    kind: c_int,
    index: c_int,
    value: *mut c_int,
) -> c_int {
    with!(p, t => {
        let mut v = 0;
        let e = t.getresultindex(kind, index, &mut v);
        // SAFETY: see `out`.
        unsafe { out(value, v) };
        e
    })
}

// ---- Options ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getoption(p: EnProject, option: c_int, value: *mut c_double) -> c_int {
    with!(p, t => {
        let mut v = 0.0;
        let e = t.getoption(option, &mut v);
        // SAFETY: see `out`.
        unsafe { out(value, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getflowunits(p: EnProject, units: *mut c_int) -> c_int {
    with!(p, t => {
        let mut v = 0;
        let e = t.getflowunits(&mut v);
        // SAFETY: see `out`.
        unsafe { out(units, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_gettimeparam(p: EnProject, param: c_int, value: *mut c_long) -> c_int {
    with!(p, t => {
        let mut v = 0i64;
        let e = t.gettimeparam(param, &mut v);
        // SAFETY: see `out`.
        unsafe { out(value, v as c_long) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_timetonextevent(
    p: EnProject,
    event_type: *mut c_int,
    duration: *mut c_long,
    element_index: *mut c_int,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b, mut c) = (0, 0i64, 0);
        let e = t.timetonextevent(&mut a, &mut b, &mut c);
        // SAFETY: see `out`.
        unsafe {
            out(event_type, a);
            out(duration, b as c_long);
            out(element_index, c);
        }
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getqualinfo(
    p: EnProject,
    qual_type: *mut c_int,
    chem_name: *mut c_char,
    chem_units: *mut c_char,
    trace_node: *mut c_int,
) -> c_int {
    with!(p, t => {
        let (mut q, mut n) = (0, 0);
        let (mut name, mut units) = (String::new(), String::new());
        let e = t.getqualinfo(&mut q, &mut name, &mut units, &mut n);
        // SAFETY: see `out` and `put` (MAXID + 1 byte buffers).
        unsafe {
            out(qual_type, q);
            out(trace_node, n);
            put(chem_name, &name, MAXID);
            put(chem_units, &units, MAXID);
        }
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getqualtype(
    p: EnProject,
    qual_type: *mut c_int,
    trace_node: *mut c_int,
) -> c_int {
    with!(p, t => {
        let (mut q, mut n) = (0, 0);
        let e = t.getqualtype(&mut q, &mut n);
        // SAFETY: see `out`.
        unsafe {
            out(trace_node, n);
            if e == 0 {
                out(qual_type, q);
            }
        }
        e
    })
}

// ---- Nodes -----------------------------------------------------------------------------

/// Index lookups by ID: `EN_getnodeindex`, `EN_getlinkindex`, ...
macro_rules! by_id {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, id: *const c_char, index: *mut c_int) -> c_int {
            // SAFETY: see `arg`.
            let id = unsafe { arg(id) }.unwrap_or_default();
            with!(p, t => {
                let mut v = 0;
                let e = t.$method(&id, &mut v);
                // SAFETY: see `out`.
                unsafe { out(index, v) };
                e
            })
        }
    };
}

/// ID lookups by index: `EN_getnodeid`, `EN_getlinkid`, ...
macro_rules! id_of {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, index: c_int, id: *mut c_char) -> c_int {
            with!(p, t => {
                let mut s = String::new();
                let e = t.$method(index, &mut s);
                // SAFETY: ID buffers hold MAXID + 1 bytes.
                unsafe { put(id, &s, MAXID) };
                e
            })
        }
    };
}

/// Integer properties by index: `EN_getnodetype`, `EN_getpatternlen`, ...
macro_rules! int_of {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, index: c_int, value: *mut c_int) -> c_int {
            with!(p, t => {
                let mut v = 0;
                let e = t.$method(index, &mut v);
                // SAFETY: see `out`.
                unsafe { out(value, v) };
                e
            })
        }
    };
    ($name:ident, $method:ident, keep) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, index: c_int, value: *mut c_int) -> c_int {
            with!(p, t => {
                let mut v = 0;
                let e = t.$method(index, &mut v);
                // These leave the output alone on error.
                if e == 0 {
                    // SAFETY: see `out`.
                    unsafe { out(value, v) };
                }
                e
            })
        }
    };
}

/// Double properties: `EN_getnodevalue`, `EN_getlinkvalue`.
macro_rules! value_of {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, index: c_int, property: c_int, value: *mut c_double) -> c_int {
            with!(p, t => {
                let mut v = 0.0;
                let e = t.$method(index, property, &mut v);
                // SAFETY: see `out`.
                unsafe { out(value, v) };
                e
            })
        }
    };
}

/// Arrays of a property: `EN_getnodevalues`, `EN_getlinkvalues`.
macro_rules! values_of {
    ($name:ident, $method:ident, $count:expr) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, property: c_int, values: *mut c_double) -> c_int {
            with!(p, t => {
                let mut n = 0;
                t.getcount($count, &mut n);
                if values.is_null() {
                    return if n > 0 { 251 } else { 0 };
                }
                // SAFETY: the caller's array holds one value per element.
                let slice = unsafe { std::slice::from_raw_parts_mut(values, n.max(0) as usize) };
                t.$method(property, slice)
            })
        }
    };
}

by_id!(EN_getnodeindex, getnodeindex);
id_of!(EN_getnodeid, getnodeid);
int_of!(EN_getnodetype, getnodetype);
value_of!(EN_getnodevalue, getnodevalue);
values_of!(EN_getnodevalues, getnodevalues, epanet::EN_NODECOUNT);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getcoord(
    p: EnProject,
    index: c_int,
    x: *mut c_double,
    y: *mut c_double,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b) = (0.0, 0.0);
        let e = t.getcoord(index, &mut a, &mut b);
        if e == 0 {
            // SAFETY: see `out`.
            unsafe {
                out(x, a);
                out(y, b);
            }
        }
        e
    })
}

// ---- Demands ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getdemandmodel(
    p: EnProject,
    model: *mut c_int,
    pmin: *mut c_double,
    preq: *mut c_double,
    pexp: *mut c_double,
) -> c_int {
    with!(p, t => {
        let (mut m, mut a, mut b, mut c) = (0, 0.0, 0.0, 0.0);
        let e = t.getdemandmodel(&mut m, &mut a, &mut b, &mut c);
        // SAFETY: see `out`.
        unsafe {
            out(model, m);
            out(pmin, a);
            out(preq, b);
            out(pexp, c);
        }
        e
    })
}

int_of!(EN_getnumdemands, getnumdemands, keep);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getbasedemand(
    p: EnProject,
    node_index: c_int,
    demand_index: c_int,
    base_demand: *mut c_double,
) -> c_int {
    with!(p, t => {
        let mut v = 0.0;
        let e = t.getbasedemand(node_index, demand_index, &mut v);
        // SAFETY: see `out`.
        unsafe { out(base_demand, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getdemandname(
    p: EnProject,
    node_index: c_int,
    demand_index: c_int,
    demand_name: *mut c_char,
) -> c_int {
    with!(p, t => {
        let mut s = String::new();
        let e = t.getdemandname(node_index, demand_index, &mut s);
        // SAFETY: name buffers hold MAXID + 1 bytes.
        unsafe { put(demand_name, &s, MAXID) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getdemandpattern(
    p: EnProject,
    node_index: c_int,
    demand_index: c_int,
    pat_index: *mut c_int,
) -> c_int {
    with!(p, t => {
        let mut v = 0;
        let e = t.getdemandpattern(node_index, demand_index, &mut v);
        // SAFETY: see `out`.
        unsafe { out(pat_index, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getdemandindex(
    p: EnProject,
    node_index: c_int,
    demand_name: *const c_char,
    demand_index: *mut c_int,
) -> c_int {
    // SAFETY: see `arg`.
    let name = unsafe { arg(demand_name) };
    with!(p, t => {
        let Some(name) = name else {
            // SAFETY: see `out`.
            unsafe { out(demand_index, 0) };
            return if t.is_open() { 253 } else { 102 };
        };
        let mut v = 0;
        let e = t.getdemandindex(node_index, &name, &mut v);
        // SAFETY: see `out`.
        unsafe { out(demand_index, v) };
        e
    })
}

// ---- Links -----------------------------------------------------------------------------

by_id!(EN_getlinkindex, getlinkindex);
id_of!(EN_getlinkid, getlinkid);
int_of!(EN_getlinktype, getlinktype);
value_of!(EN_getlinkvalue, getlinkvalue);
values_of!(EN_getlinkvalues, getlinkvalues, epanet::EN_LINKCOUNT);
int_of!(EN_getvertexcount, getvertexcount);
int_of!(EN_getpumptype, getpumptype);
int_of!(EN_getheadcurveindex, getheadcurveindex);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getlinknodes(
    p: EnProject,
    index: c_int,
    node1: *mut c_int,
    node2: *mut c_int,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b) = (0, 0);
        let e = t.getlinknodes(index, &mut a, &mut b);
        // SAFETY: see `out`.
        unsafe {
            out(node1, a);
            out(node2, b);
        }
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getvertex(
    p: EnProject,
    index: c_int,
    vertex: c_int,
    x: *mut c_double,
    y: *mut c_double,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b) = (0.0, 0.0);
        let e = t.getvertex(index, vertex, &mut a, &mut b);
        // SAFETY: see `out`.
        unsafe {
            out(x, a);
            out(y, b);
        }
        e
    })
}

// ---- Time patterns ---------------------------------------------------------------------

by_id!(EN_getpatternindex, getpatternindex);
id_of!(EN_getpatternid, getpatternid);
int_of!(EN_getpatternlen, getpatternlen, keep);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getpatternvalue(
    p: EnProject,
    index: c_int,
    period: c_int,
    value: *mut c_double,
) -> c_int {
    with!(p, t => {
        let mut v = 0.0;
        let e = t.getpatternvalue(index, period, &mut v);
        // SAFETY: see `out`.
        unsafe { out(value, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getaveragepatternvalue(
    p: EnProject,
    index: c_int,
    value: *mut c_double,
) -> c_int {
    with!(p, t => {
        let mut v = 0.0;
        let e = t.getaveragepatternvalue(index, &mut v);
        // SAFETY: see `out`.
        unsafe { out(value, v) };
        e
    })
}

// ---- Data curves -----------------------------------------------------------------------

by_id!(EN_getcurveindex, getcurveindex);
id_of!(EN_getcurveid, getcurveid);
int_of!(EN_getcurvelen, getcurvelen, keep);
int_of!(EN_getcurvetype, getcurvetype, keep);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getcurvevalue(
    p: EnProject,
    curve_index: c_int,
    point_index: c_int,
    x: *mut c_double,
    y: *mut c_double,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b) = (0.0, 0.0);
        let e = t.getcurvevalue(curve_index, point_index, &mut a, &mut b);
        // SAFETY: see `out`.
        unsafe {
            out(x, a);
            out(y, b);
        }
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getcurve(
    p: EnProject,
    index: c_int,
    id: *mut c_char,
    n_points: *mut c_int,
    x_values: *mut c_double,
    y_values: *mut c_double,
) -> c_int {
    with!(p, t => {
        if t.is_open() && (x_values.is_null() || y_values.is_null()) {
            let mut n = 0;
            t.getcount(epanet::EN_CURVECOUNT, &mut n);
            if index > 0 && index <= n {
                return 206;
            }
        }
        let (mut s, mut xs, mut ys) = (String::new(), Vec::new(), Vec::new());
        let e = t.getcurve(index, &mut s, &mut xs, &mut ys);
        if e == 0 {
            // SAFETY: the caller's arrays hold the curve's points (EN_getcurvelen).
            unsafe {
                put(id, &s, MAXID);
                out(n_points, xs.len() as c_int);
                std::ptr::copy_nonoverlapping(xs.as_ptr(), x_values, xs.len());
                std::ptr::copy_nonoverlapping(ys.as_ptr(), y_values, ys.len());
            }
        }
        e
    })
}

// ---- Simple controls -------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getcontrol(
    p: EnProject,
    index: c_int,
    control_type: *mut c_int,
    link_index: *mut c_int,
    setting: *mut c_double,
    node_index: *mut c_int,
    level: *mut c_double,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b, mut c, mut d, mut f) = (0, 0, 0.0, 0, 0.0);
        let e = t.getcontrol(index, &mut a, &mut b, &mut c, &mut d, &mut f);
        // SAFETY: see `out`.
        unsafe {
            out(control_type, a);
            out(link_index, b);
            out(node_index, d);
            if e == 0 {
                out(setting, c);
                out(level, f);
            }
        }
        e
    })
}

int_of!(EN_getcontrolenabled, getcontrolenabled, keep);

// ---- Setters ---------------------------------------------------------------------------

/// A C string argument, or "" for a null pointer.
unsafe fn text(s: *const c_char) -> String {
    // SAFETY: see `arg`.
    unsafe { arg(s) }.unwrap_or_default()
}

/// A caller's array of `n` doubles (empty for a null pointer or n <= 0).
unsafe fn doubles<'a>(v: *const c_double, n: c_int) -> &'a [c_double] {
    if v.is_null() || n <= 0 {
        return &[];
    }
    // SAFETY: the caller's array holds n values.
    unsafe { std::slice::from_raw_parts(v, n as usize) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_settitle(
    p: EnProject,
    line1: *const c_char,
    line2: *const c_char,
    line3: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let (a, b, c) = unsafe { (text(line1), text(line2), text(line3)) };
    with!(p, t => t.settitle(&a, &b, &c))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setcomment(
    p: EnProject,
    object: c_int,
    index: c_int,
    comment: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(comment) };
    with!(p, t => t.setcomment(object, index, &s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_settag(
    p: EnProject,
    object: c_int,
    index: c_int,
    tag: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(tag) };
    with!(p, t => t.settag(object, index, &s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setoption(p: EnProject, option: c_int, value: c_double) -> c_int {
    with!(p, t => t.setoption(option, value))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setflowunits(p: EnProject, units: c_int) -> c_int {
    with!(p, t => t.setflowunits(units))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_settimeparam(p: EnProject, param: c_int, value: c_long) -> c_int {
    // c_long is 32 bits on Windows.
    #[allow(clippy::useless_conversion)]
    let value = i64::from(value);
    with!(p, t => t.settimeparam(param, value))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setqualtype(
    p: EnProject,
    qual_type: c_int,
    chem_name: *const c_char,
    chem_units: *const c_char,
    trace_node: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let (a, b, c) = unsafe { (text(chem_name), text(chem_units), text(trace_node)) };
    with!(p, t => t.setqualtype(qual_type, &a, &b, &c))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setnodeid(p: EnProject, index: c_int, new_id: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(new_id) };
    with!(p, t => t.setnodeid(index, &s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setnodevalue(
    p: EnProject,
    index: c_int,
    property: c_int,
    value: c_double,
) -> c_int {
    with!(p, t => t.setnodevalue(index, property, value))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setjuncdata(
    p: EnProject,
    index: c_int,
    elev: c_double,
    dmnd: c_double,
    dmndpat: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(dmndpat) };
    with!(p, t => t.setjuncdata(index, elev, dmnd, &s))
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn EN_settankdata(
    p: EnProject,
    index: c_int,
    elev: c_double,
    initlvl: c_double,
    minlvl: c_double,
    maxlvl: c_double,
    diam: c_double,
    minvol: c_double,
    volcurve: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(volcurve) };
    with!(p, t => t.settankdata(index, elev, initlvl, minlvl, maxlvl, diam, minvol, &s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setcoord(
    p: EnProject,
    index: c_int,
    x: c_double,
    y: c_double,
) -> c_int {
    with!(p, t => t.setcoord(index, x, y))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setdemandmodel(
    p: EnProject,
    model: c_int,
    pmin: c_double,
    preq: c_double,
    pexp: c_double,
) -> c_int {
    with!(p, t => t.setdemandmodel(model, pmin, preq, pexp))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_adddemand(
    p: EnProject,
    node_index: c_int,
    base_demand: c_double,
    demand_pattern: *const c_char,
    demand_name: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let (a, b) = unsafe { (text(demand_pattern), text(demand_name)) };
    with!(p, t => t.adddemand(node_index, base_demand, &a, &b))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_deletedemand(
    p: EnProject,
    node_index: c_int,
    demand_index: c_int,
) -> c_int {
    with!(p, t => t.deletedemand(node_index, demand_index))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setbasedemand(
    p: EnProject,
    node_index: c_int,
    demand_index: c_int,
    base_demand: c_double,
) -> c_int {
    with!(p, t => t.setbasedemand(node_index, demand_index, base_demand))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setdemandname(
    p: EnProject,
    node_index: c_int,
    demand_index: c_int,
    demand_name: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(demand_name) };
    with!(p, t => t.setdemandname(node_index, demand_index, &s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setdemandpattern(
    p: EnProject,
    node_index: c_int,
    demand_index: c_int,
    pat_index: c_int,
) -> c_int {
    with!(p, t => t.setdemandpattern(node_index, demand_index, pat_index))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setlinkid(p: EnProject, index: c_int, new_id: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(new_id) };
    with!(p, t => t.setlinkid(index, &s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setlinkvalue(
    p: EnProject,
    index: c_int,
    property: c_int,
    value: c_double,
) -> c_int {
    with!(p, t => t.setlinkvalue(index, property, value))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setpipedata(
    p: EnProject,
    index: c_int,
    length: c_double,
    diam: c_double,
    rough: c_double,
    mloss: c_double,
) -> c_int {
    with!(p, t => t.setpipedata(index, length, diam, rough, mloss))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setvertex(
    p: EnProject,
    index: c_int,
    vertex: c_int,
    x: c_double,
    y: c_double,
) -> c_int {
    with!(p, t => t.setvertex(index, vertex, x, y))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setvertices(
    p: EnProject,
    index: c_int,
    x: *const c_double,
    y: *const c_double,
    count: c_int,
) -> c_int {
    // SAFETY: see `doubles`.
    let (xs, ys) = unsafe { (doubles(x, count), doubles(y, count)) };
    with!(p, t => t.setvertices(index, xs, ys))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setheadcurveindex(
    p: EnProject,
    link_index: c_int,
    curve_index: c_int,
) -> c_int {
    with!(p, t => t.setheadcurveindex(link_index, curve_index))
}

/// Calls taking one ID: `EN_addpattern`, `EN_addcurve`.
macro_rules! with_id {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, id: *const c_char) -> c_int {
            // SAFETY: see `text`.
            let s = unsafe { text(id) };
            with!(p, t => t.$method(&s))
        }
    };
}

/// Calls taking an index and an ID: `EN_setpatternid`, `EN_setcurveid`.
macro_rules! index_id {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, index: c_int, id: *const c_char) -> c_int {
            // SAFETY: see `text`.
            let s = unsafe { text(id) };
            with!(p, t => t.$method(index, &s))
        }
    };
}

/// Calls taking an index: `EN_deletepattern`, `EN_deletecurve`, `EN_deletecontrol`.
macro_rules! by_index {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(p: EnProject, index: c_int) -> c_int {
            with!(p, t => t.$method(index))
        }
    };
}

with_id!(EN_addpattern, addpattern);
by_index!(EN_deletepattern, deletepattern);
index_id!(EN_setpatternid, setpatternid);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setpatternvalue(
    p: EnProject,
    index: c_int,
    period: c_int,
    value: c_double,
) -> c_int {
    with!(p, t => t.setpatternvalue(index, period, value))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setpattern(
    p: EnProject,
    index: c_int,
    values: *const c_double,
    len: c_int,
) -> c_int {
    with!(p, t => {
        if values.is_null() {
            return if t.is_open() { 205 } else { 102 };
        }
        // SAFETY: see `doubles`.
        let v = unsafe { doubles(values, len) };
        t.setpattern(index, v)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_loadpatternfile(
    p: EnProject,
    filename: *const c_char,
    id: *const c_char,
) -> c_int {
    // SAFETY: see `text`.
    let (f, i) = unsafe { (text(filename), text(id)) };
    with!(p, t => t.loadpatternfile(&f, &i))
}

with_id!(EN_addcurve, addcurve);
by_index!(EN_deletecurve, deletecurve);
index_id!(EN_setcurveid, setcurveid);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setcurvetype(p: EnProject, index: c_int, kind: c_int) -> c_int {
    with!(p, t => t.setcurvetype(index, kind))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setcurvevalue(
    p: EnProject,
    curve_index: c_int,
    point_index: c_int,
    x: c_double,
    y: c_double,
) -> c_int {
    with!(p, t => t.setcurvevalue(curve_index, point_index, x, y))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setcurve(
    p: EnProject,
    index: c_int,
    x_values: *const c_double,
    y_values: *const c_double,
    n_points: c_int,
) -> c_int {
    with!(p, t => {
        if !t.is_open() {
            return 102;
        }
        let mut n = 0;
        t.getcount(epanet::EN_CURVECOUNT, &mut n);
        if index <= 0 || index > n || x_values.is_null() || y_values.is_null() {
            return 206;
        }
        if n_points <= 0 {
            return 202;
        }
        // SAFETY: see `doubles`.
        let (xs, ys) = unsafe { (doubles(x_values, n_points), doubles(y_values, n_points)) };
        t.setcurve(index, xs, ys)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_addcontrol(
    p: EnProject,
    kind: c_int,
    link_index: c_int,
    setting: c_double,
    node_index: c_int,
    level: c_double,
    index: *mut c_int,
) -> c_int {
    with!(p, t => {
        let mut v = 0;
        let e = t.addcontrol(kind, link_index, setting, node_index, level, &mut v);
        if e == 0 {
            // SAFETY: see `out`.
            unsafe { out(index, v) };
        }
        e
    })
}

by_index!(EN_deletecontrol, deletecontrol);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setcontrol(
    p: EnProject,
    index: c_int,
    kind: c_int,
    link_index: c_int,
    setting: c_double,
    node_index: c_int,
    level: c_double,
) -> c_int {
    with!(p, t => t.setcontrol(index, kind, link_index, setting, node_index, level))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setcontrolenabled(p: EnProject, index: c_int, enabled: c_int) -> c_int {
    with!(p, t => t.setcontrolenabled(index, enabled))
}

// ---- Network structure -----------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_addnode(
    p: EnProject,
    id: *const c_char,
    node_type: c_int,
    index: *mut c_int,
) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(id) };
    with!(p, t => {
        let mut v = 0;
        let e = t.addnode(&s, node_type, &mut v);
        // SAFETY: see `out`.
        unsafe { out(index, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_deletenode(p: EnProject, index: c_int, action_code: c_int) -> c_int {
    with!(p, t => t.deletenode(index, action_code))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_addlink(
    p: EnProject,
    id: *const c_char,
    link_type: c_int,
    from_node: *const c_char,
    to_node: *const c_char,
    index: *mut c_int,
) -> c_int {
    // SAFETY: see `text`.
    let (s, a, b) = unsafe { (text(id), text(from_node), text(to_node)) };
    with!(p, t => {
        let mut v = 0;
        let e = t.addlink(&s, link_type, &a, &b, &mut v);
        // SAFETY: see `out`.
        unsafe { out(index, v) };
        e
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_deletelink(p: EnProject, index: c_int, action_code: c_int) -> c_int {
    with!(p, t => t.deletelink(index, action_code))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setlinknodes(
    p: EnProject,
    index: c_int,
    node1: c_int,
    node2: c_int,
) -> c_int {
    with!(p, t => t.setlinknodes(index, node1, node2))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setlinktype(
    p: EnProject,
    index: *mut c_int,
    link_type: c_int,
    action_code: c_int,
) -> c_int {
    with!(p, t => {
        // SAFETY: index points at the caller's link index, read and rewritten.
        let Some(i) = (unsafe { index.as_mut() }) else { return 204 };
        let mut v = *i;
        let e = t.setlinktype(&mut v, link_type, action_code);
        *i = v;
        e
    })
}

// ---- Rule-based controls ---------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_addrule(p: EnProject, rule: *mut c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(rule) };
    with!(p, t => t.addrule(&s))
}

by_index!(EN_deleterule, deleterule);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_getrule(
    p: EnProject,
    index: c_int,
    n_premises: *mut c_int,
    n_then_actions: *mut c_int,
    n_else_actions: *mut c_int,
    priority: *mut c_double,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b, mut c, mut d) = (0, 0, 0, 0.0);
        let e = t.getrule(index, &mut a, &mut b, &mut c, &mut d);
        if e == 0 {
            // SAFETY: see `out`.
            unsafe {
                out(n_premises, a);
                out(n_then_actions, b);
                out(n_else_actions, c);
                out(priority, d);
            }
        }
        e
    })
}

id_of!(EN_getruleID, getruleid);

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn EN_getpremise(
    p: EnProject,
    rule_index: c_int,
    premise_index: c_int,
    logop: *mut c_int,
    object: *mut c_int,
    obj_index: *mut c_int,
    variable: *mut c_int,
    relop: *mut c_int,
    status: *mut c_int,
    value: *mut c_double,
) -> c_int {
    with!(p, t => {
        let (mut a, mut b, mut c, mut d, mut e2, mut f, mut g) = (0, 0, 0, 0, 0, 0, 0.0);
        let e = t.getpremise(rule_index, premise_index, &mut a, &mut b, &mut c, &mut d, &mut e2, &mut f, &mut g);
        if e == 0 {
            // SAFETY: see `out`.
            unsafe {
                out(logop, a);
                out(object, b);
                out(obj_index, c);
                out(variable, d);
                out(relop, e2);
                out(status, f);
                out(value, g);
            }
        }
        e
    })
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn EN_setpremise(
    p: EnProject,
    rule_index: c_int,
    premise_index: c_int,
    logop: c_int,
    object: c_int,
    obj_index: c_int,
    variable: c_int,
    relop: c_int,
    status: c_int,
    value: c_double,
) -> c_int {
    with!(p, t => t.setpremise(rule_index, premise_index, logop, object, obj_index, variable, relop, status, value))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setpremiseindex(
    p: EnProject,
    rule_index: c_int,
    premise_index: c_int,
    obj_index: c_int,
) -> c_int {
    with!(p, t => t.setpremiseindex(rule_index, premise_index, obj_index))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setpremisestatus(
    p: EnProject,
    rule_index: c_int,
    premise_index: c_int,
    status: c_int,
) -> c_int {
    with!(p, t => t.setpremisestatus(rule_index, premise_index, status))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setpremisevalue(
    p: EnProject,
    rule_index: c_int,
    premise_index: c_int,
    value: c_double,
) -> c_int {
    with!(p, t => t.setpremisevalue(rule_index, premise_index, value))
}

macro_rules! get_action {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(
            p: EnProject,
            rule_index: c_int,
            action_index: c_int,
            link_index: *mut c_int,
            status: *mut c_int,
            setting: *mut c_double,
        ) -> c_int {
            with!(p, t => {
                let (mut a, mut b, mut c) = (0, 0, 0.0);
                let e = t.$method(rule_index, action_index, &mut a, &mut b, &mut c);
                if e == 0 {
                    // SAFETY: see `out`.
                    unsafe {
                        out(link_index, a);
                        out(status, b);
                        out(setting, c);
                    }
                }
                e
            })
        }
    };
}

macro_rules! set_action {
    ($name:ident, $method:ident) => {
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $name(
            p: EnProject,
            rule_index: c_int,
            action_index: c_int,
            link_index: c_int,
            status: c_int,
            setting: c_double,
        ) -> c_int {
            with!(p, t => t.$method(rule_index, action_index, link_index, status, setting))
        }
    };
}

get_action!(EN_getthenaction, getthenaction);
get_action!(EN_getelseaction, getelseaction);
set_action!(EN_setthenaction, setthenaction);
set_action!(EN_setelseaction, setelseaction);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setrulepriority(
    p: EnProject,
    index: c_int,
    priority: c_double,
) -> c_int {
    with!(p, t => t.setrulepriority(index, priority))
}

int_of!(EN_getruleenabled, getruleenabled, keep);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setruleenabled(p: EnProject, index: c_int, enabled: c_int) -> c_int {
    with!(p, t => t.setruleenabled(index, enabled))
}

// ---- Reports ---------------------------------------------------------------------------

simple!(EN_report, report);
simple!(EN_saveH, save_h);
simple!(EN_resetreport, resetreport);
simple!(EN_clearreport, clearreport);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_writeline(p: EnProject, line: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(line) };
    with!(p, t => t.writeline(&s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setreport(p: EnProject, format: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(format) };
    with!(p, t => t.setreport(&s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setstatusreport(p: EnProject, level: c_int) -> c_int {
    with!(p, t => t.setstatusreport(level))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_copyreport(p: EnProject, filename: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(filename) };
    with!(p, t => t.copyreport(&s))
}

/// `EN_savehydfile`
#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_savehydfile(p: EnProject, filename: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(filename) };
    with!(p, t => t.savehydfile(&s))
}

/// `EN_usehydfile`
#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_usehydfile(p: EnProject, filename: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(filename) };
    with!(p, t => t.usehydfile(&s))
}

/// `EN_saveinpfile`
#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_saveinpfile(p: EnProject, filename: *const c_char) -> c_int {
    // SAFETY: see `text`.
    let s = unsafe { text(filename) };
    with!(p, t => t.saveinpfile(&s))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setreportcallback(
    p: EnProject,
    callback: Option<ReportCallback>,
) -> c_int {
    // SAFETY: see `tk`.
    let Some(h) = (unsafe { tk(p) }) else {
        return 102;
    };
    h.flush();
    h.callback = callback;
    h.tk.set_report_callback(callback.is_some());
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn EN_setreportcallbackuserdata(
    p: EnProject,
    user_data: *mut c_void,
) -> c_int {
    // SAFETY: see `tk`.
    let Some(h) = (unsafe { tk(p) }) else {
        return 102;
    };
    h.user_data = user_data;
    0
}
