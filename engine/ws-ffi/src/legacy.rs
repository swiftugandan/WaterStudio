// SPDX-License-Identifier: MIT
// The API is OWA-EPANET 2.3's legacy API (epanet2.h, epanet2.c), Copyright (c) 2019
// OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.

//! The legacy single-precision API of `epanet2.h`: the `EN...` functions without a
//! project argument, which act on one project the library keeps, with real values as
//! `float`. Each forwards to its `EN_` counterpart as `epanet2.c` does. The wrappers that
//! only forward are generated from `epanet2.c` (`scripts/gen-legacy-api.py`, then
//! `cargo fmt`); the rest are written out below.

#![allow(non_snake_case)]
#![allow(clippy::missing_safety_doc)]

use std::ffi::{c_char, c_double, c_int, c_long, c_void};
use std::ptr::null_mut;
use std::sync::atomic::{AtomicPtr, Ordering};

use crate::{EnProject, Handle, ReportCallback, out, tk};

/// `_defaultProject`, made on first use.
static DEFAULT: AtomicPtr<Handle> = AtomicPtr::new(null_mut());

fn default_project() -> EnProject {
    let p = DEFAULT.load(Ordering::Acquire);
    if !p.is_null() {
        return p;
    }
    let mut h: EnProject = null_mut();
    // SAFETY: EN_createproject writes a fresh handle through a valid pointer.
    unsafe { crate::EN_createproject(&raw mut h) };
    match DEFAULT.compare_exchange(null_mut(), h, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => h,
        Err(existing) => {
            // SAFETY: `h` was made above and never shared.
            unsafe { crate::EN_deleteproject(h) };
            existing
        }
    }
}

// ---- Written out ---------------------------------------------------------------------

/// `ENepanet`: a whole run; a warning is returned only when no error occurred.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENepanet(
    inp_file: *const c_char,
    rpt_file: *const c_char,
    out_file: *const c_char,
    pviewprog: Option<unsafe extern "C" fn(*mut c_char)>,
) -> c_int {
    // SAFETY: forwarded as given.
    let errcode =
        unsafe { crate::EN_runproject(default_project(), inp_file, rpt_file, out_file, pviewprog) };
    let warncode = if errcode < 100 { errcode } else { 0 };
    if warncode != 0 {
        errcode.max(warncode)
    } else {
        errcode
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENinit(
    rpt_file: *const c_char,
    out_file: *const c_char,
    units_type: c_int,
    headloss_type: c_int,
) -> c_int {
    // SAFETY: forwarded as given.
    unsafe {
        crate::EN_init(
            default_project(),
            rpt_file,
            out_file,
            units_type,
            headloss_type,
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENopen(
    inp_file: *const c_char,
    rpt_file: *const c_char,
    out_file: *const c_char,
) -> c_int {
    // SAFETY: forwarded as given.
    unsafe { crate::EN_open(default_project(), inp_file, rpt_file, out_file) }
}

/// `ENclose`: always 0.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENclose() -> c_int {
    // SAFETY: the default project is a valid handle.
    unsafe { crate::EN_close(default_project()) };
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetversion(version: *mut c_int) -> c_int {
    // SAFETY: forwarded as given.
    unsafe { crate::EN_getversion(version) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgeterror(errcode: c_int, errmsg: *mut c_char, max_len: c_int) -> c_int {
    // SAFETY: forwarded as given.
    unsafe { crate::EN_geterror(errcode, errmsg, max_len) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetreportcallback(callback: Option<ReportCallback>) -> c_int {
    // SAFETY: forwarded as given.
    unsafe { crate::EN_setreportcallback(default_project(), callback) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetreportcallbackuserdata(user_data: *mut c_void) -> c_int {
    // SAFETY: forwarded as given.
    unsafe { crate::EN_setreportcallbackuserdata(default_project(), user_data) }
}

/// The number of nodes or links (`EN_NODECOUNT`, `EN_LINKCOUNT`), 0 if none is open.
fn count(object: c_int) -> c_int {
    let mut n = 0;
    // SAFETY: a valid handle and output pointer.
    unsafe { crate::EN_getcount(default_project(), object, &raw mut n) };
    n
}

/// `ENgetnodevalues`: each node's value in turn, stopping at the first error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetnodevalues(property: c_int, values: *mut f32) -> c_int {
    for i in 1..=count(0) {
        let mut v = 0.0f32;
        // SAFETY: a valid output pointer.
        let errcode = unsafe { ENgetnodevalue(i, property, &raw mut v) };
        // SAFETY: the caller's array holds a value per node.
        unsafe { out(values.wrapping_add(i as usize - 1), v) };
        if errcode != 0 {
            return errcode;
        }
    }
    0
}

/// `ENgetlinkvalues`: each link's value in turn, stopping at the first error.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetlinkvalues(property: c_int, values: *mut f32) -> c_int {
    for i in 1..=count(2) {
        let mut v = 0.0f32;
        // SAFETY: a valid output pointer.
        let errcode = unsafe { ENgetlinkvalue(i, property, &raw mut v) };
        // SAFETY: the caller's array holds a value per link.
        unsafe { out(values.wrapping_add(i as usize - 1), v) };
        if errcode != 0 {
            return errcode;
        }
    }
    0
}

/// The caller's `n` floats as doubles (101, as a failed `calloc`, for a negative count).
unsafe fn doubles(values: *const f32, n: c_int) -> Option<Vec<f64>> {
    let n = usize::try_from(n).ok()?;
    // SAFETY: the caller's array holds `n` values.
    Some(
        (0..n)
            .map(|i| f64::from(unsafe { *values.add(i) }))
            .collect(),
    )
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpattern(index: c_int, values: *mut f32, len: c_int) -> c_int {
    if values.is_null() {
        return 206;
    }
    // SAFETY: see `doubles`.
    let Some(v) = (unsafe { doubles(values, len) }) else {
        return 101;
    };
    // SAFETY: `v` holds `len` values.
    unsafe { crate::EN_setpattern(default_project(), index, v.as_ptr(), len) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcurve(
    index: c_int,
    x_values: *mut f32,
    y_values: *mut f32,
    n_points: c_int,
) -> c_int {
    if x_values.is_null() || y_values.is_null() {
        return 206;
    }
    if n_points < 1 {
        return 202;
    }
    // SAFETY: see `doubles`.
    let (Some(x), Some(y)) = (unsafe { doubles(x_values, n_points) }, unsafe {
        doubles(y_values, n_points)
    }) else {
        return 101;
    };
    // SAFETY: `x` and `y` hold `n_points` values.
    unsafe { crate::EN_setcurve(default_project(), index, x.as_ptr(), y.as_ptr(), n_points) }
}

/// `ENgetcurve`: a curve's ID (`strncpy` of `MAXID` bytes), points and values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcurve(
    index: c_int,
    id: *mut c_char,
    n_points: *mut c_int,
    x_values: *mut f32,
    y_values: *mut f32,
) -> c_int {
    // SAFETY: see `tk`.
    let Some(h) = (unsafe { tk(default_project()) }) else {
        return 206;
    };
    let mut n = 0;
    if !h.tk.is_open() || h.tk.getcurvelen(index, &mut n) != 0 {
        return 206;
    }
    if x_values.is_null() || y_values.is_null() {
        return 206;
    }
    let mut name = String::new();
    h.tk.getcurveid(index, &mut name);
    if !id.is_null() {
        let bytes = name.as_bytes();
        let max = ws_solver::epanet::MAXID;
        for k in 0..max {
            // SAFETY: the caller's buffer holds MAXID + 1 bytes; strncpy pads with NULs.
            unsafe { *id.add(k) = bytes.get(k).copied().unwrap_or(0) as c_char };
        }
    }
    // SAFETY: a valid output pointer or null.
    unsafe { out(n_points, n) };
    for i in 0..n {
        let (mut x, mut y) = (0.0, 0.0);
        h.tk.getcurvevalue(index, i + 1, &mut x, &mut y);
        // SAFETY: the caller's arrays hold a value per point.
        unsafe {
            *x_values.add(i as usize) = x as f32;
            *y_values.add(i as usize) = y as f32;
        }
    }
    0
}

// ---- Generated -----------------------------------------------------------------------

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgettitle(
    line1: *mut c_char,
    line2: *mut c_char,
    line3: *mut c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_gettitle(default_project(), line1, line2, line3) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsettitle(
    line1: *const c_char,
    line2: *const c_char,
    line3: *const c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_settitle(default_project(), line1, line2, line3) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcomment(object: c_int, index: c_int, comment: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcomment(default_project(), object, index, comment) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcomment(
    object: c_int,
    index: c_int,
    comment: *const c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setcomment(default_project(), object, index, comment) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgettag(object: c_int, index: c_int, tag: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_gettag(default_project(), object, index, tag) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsettag(object: c_int, index: c_int, tag: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_settag(default_project(), object, index, tag) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcount(object: c_int, count: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcount(default_project(), object, count) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsaveinpfile(filename: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_saveinpfile(default_project(), filename) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsolveH() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_solveH(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsaveH() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_saveH(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENopenH() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_openH(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENinitH(init_flag: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_initH(default_project(), init_flag) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENrunH(current_time: *mut c_long) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_runH(default_project(), current_time) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENnextH(t_step: *mut c_long) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_nextH(default_project(), t_step) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENcloseH() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_closeH(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsavehydfile(filename: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_savehydfile(default_project(), filename) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENusehydfile(filename: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_usehydfile(default_project(), filename) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsolveQ() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_solveQ(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENopenQ() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_openQ(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENinitQ(save_flag: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_initQ(default_project(), save_flag) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENrunQ(current_time: *mut c_long) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_runQ(default_project(), current_time) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENnextQ(t_step: *mut c_long) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_nextQ(default_project(), t_step) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENstepQ(time_left: *mut c_long) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_stepQ(default_project(), time_left) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENcloseQ() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_closeQ(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENwriteline(line: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_writeline(default_project(), line) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENreport() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_report(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENcopyreport(filename: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_copyreport(default_project(), filename) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENclearreport() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_clearreport(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENresetreport() -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_resetreport(default_project()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetreport(format: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setreport(default_project(), format) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetstatusreport(level: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setstatusreport(default_project(), level) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetstatistic(kind: c_int, value: *mut f32) -> c_int {
    let mut v = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe { crate::EN_getstatistic(default_project(), kind, &raw mut v) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(value, v as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetresultindex(kind: c_int, index: c_int, value: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getresultindex(default_project(), kind, index, value) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENtimetonextevent(
    event_type: *mut c_int,
    duration: *mut c_long,
    element_index: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_timetonextevent(default_project(), event_type, duration, element_index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetoption(option: c_int, value: *mut f32) -> c_int {
    let mut v = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe { crate::EN_getoption(default_project(), option, &raw mut v) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(value, v as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetoption(option: c_int, value: f32) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setoption(default_project(), option, f64::from(value)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetflowunits(units: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getflowunits(default_project(), units) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetflowunits(units: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setflowunits(default_project(), units) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgettimeparam(param: c_int, value: *mut c_long) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_gettimeparam(default_project(), param, value) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsettimeparam(param: c_int, value: c_long) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_settimeparam(default_project(), param, value) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetqualinfo(
    qual_type: *mut c_int,
    chem_name: *mut c_char,
    chem_units: *mut c_char,
    trace_node: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_getqualinfo(
            default_project(),
            qual_type,
            chem_name,
            chem_units,
            trace_node,
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetqualtype(qual_type: *mut c_int, trace_node: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getqualtype(default_project(), qual_type, trace_node) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetqualtype(
    qual_type: c_int,
    chem_name: *const c_char,
    chem_units: *const c_char,
    trace_node: *const c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setqualtype(
            default_project(),
            qual_type,
            chem_name,
            chem_units,
            trace_node,
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENaddnode(
    id: *const c_char,
    node_type: c_int,
    index: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_addnode(default_project(), id, node_type, index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENdeletenode(index: c_int, action_code: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_deletenode(default_project(), index, action_code) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetnodeindex(id: *const c_char, index: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getnodeindex(default_project(), id, index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetnodeid(index: c_int, id: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getnodeid(default_project(), index, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetnodeid(index: c_int, newid: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setnodeid(default_project(), index, newid) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetnodetype(index: c_int, node_type: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getnodetype(default_project(), index, node_type) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetnodevalue(index: c_int, property: c_int, value: *mut f32) -> c_int {
    let mut v = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe { crate::EN_getnodevalue(default_project(), index, property, &raw mut v) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(value, v as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetnodevalue(index: c_int, property: c_int, value: f32) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setnodevalue(default_project(), index, property, f64::from(value)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetjuncdata(
    index: c_int,
    elev: f32,
    dmnd: f32,
    dmndpat: *const c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setjuncdata(
            default_project(),
            index,
            f64::from(elev),
            f64::from(dmnd),
            dmndpat,
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsettankdata(
    index: c_int,
    elev: f32,
    initlvl: f32,
    minlvl: f32,
    maxlvl: f32,
    diam: f32,
    minvol: f32,
    volcurve: *const c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_settankdata(
            default_project(),
            index,
            f64::from(elev),
            f64::from(initlvl),
            f64::from(minlvl),
            f64::from(maxlvl),
            f64::from(diam),
            f64::from(minvol),
            volcurve,
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcoord(index: c_int, x: *mut c_double, y: *mut c_double) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcoord(default_project(), index, x, y) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcoord(index: c_int, x: c_double, y: c_double) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setcoord(default_project(), index, x, y) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetdemandmodel(
    model: *mut c_int,
    pmin: *mut f32,
    preq: *mut f32,
    pexp: *mut f32,
) -> c_int {
    let mut pmin2 = 0.0f64;
    let mut preq2 = 0.0f64;
    let mut pexp2 = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getdemandmodel(
            default_project(),
            model,
            &raw mut pmin2,
            &raw mut preq2,
            &raw mut pexp2,
        )
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(pmin, pmin2 as f32) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(preq, preq2 as f32) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(pexp, pexp2 as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetdemandmodel(model: c_int, pmin: f32, preq: f32, pexp: f32) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setdemandmodel(
            default_project(),
            model,
            f64::from(pmin),
            f64::from(preq),
            f64::from(pexp),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENadddemand(
    node_index: c_int,
    base_demand: f32,
    demand_pattern: *const c_char,
    demand_name: *const c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_adddemand(
            default_project(),
            node_index,
            f64::from(base_demand),
            demand_pattern,
            demand_name,
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENdeletedemand(node_index: c_int, demand_index: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_deletedemand(default_project(), node_index, demand_index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetdemandindex(
    node_index: c_int,
    demand_name: *const c_char,
    demand_index: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getdemandindex(default_project(), node_index, demand_name, demand_index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetnumdemands(node_index: c_int, num_demands: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getnumdemands(default_project(), node_index, num_demands) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetbasedemand(
    node_index: c_int,
    demand_index: c_int,
    base_demand: *mut f32,
) -> c_int {
    let mut bd2 = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getbasedemand(default_project(), node_index, demand_index, &raw mut bd2)
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(base_demand, bd2 as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetbasedemand(
    node_index: c_int,
    demand_index: c_int,
    base_demand: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setbasedemand(
            default_project(),
            node_index,
            demand_index,
            f64::from(base_demand),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetdemandpattern(
    node_index: c_int,
    demand_index: c_int,
    pat_index: c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setdemandpattern(default_project(), node_index, demand_index, pat_index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetdemandpattern(
    node_index: c_int,
    demand_index: c_int,
    patt_idx: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getdemandpattern(default_project(), node_index, demand_index, patt_idx) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetdemandname(
    node_index: c_int,
    demand_index: c_int,
    demand_name: *mut c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getdemandname(default_project(), node_index, demand_index, demand_name) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetdemandname(
    node_index: c_int,
    demand_index: c_int,
    demand_name: *const c_char,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setdemandname(default_project(), node_index, demand_index, demand_name) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENaddlink(
    id: *const c_char,
    link_type: c_int,
    from_node: *const c_char,
    to_node: *const c_char,
    index: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_addlink(default_project(), id, link_type, from_node, to_node, index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENdeletelink(index: c_int, action_code: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_deletelink(default_project(), index, action_code) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetlinkindex(id: *const c_char, index: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getlinkindex(default_project(), id, index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetlinkid(index: c_int, id: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getlinkid(default_project(), index, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetlinkid(index: c_int, newid: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setlinkid(default_project(), index, newid) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetlinktype(index: c_int, link_type: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getlinktype(default_project(), index, link_type) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetlinktype(
    index: *mut c_int,
    link_type: c_int,
    action_code: c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setlinktype(default_project(), index, link_type, action_code) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetlinknodes(
    index: c_int,
    node1: *mut c_int,
    node2: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getlinknodes(default_project(), index, node1, node2) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetlinknodes(index: c_int, node1: c_int, node2: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setlinknodes(default_project(), index, node1, node2) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetlinkvalue(index: c_int, property: c_int, value: *mut f32) -> c_int {
    let mut v = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe { crate::EN_getlinkvalue(default_project(), index, property, &raw mut v) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(value, v as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetlinkvalue(index: c_int, property: c_int, value: f32) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setlinkvalue(default_project(), index, property, f64::from(value)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpipedata(
    index: c_int,
    length: f32,
    diam: f32,
    rough: f32,
    mloss: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setpipedata(
            default_project(),
            index,
            f64::from(length),
            f64::from(diam),
            f64::from(rough),
            f64::from(mloss),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetvertexcount(index: c_int, count: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getvertexcount(default_project(), index, count) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetvertex(
    index: c_int,
    vertex: c_int,
    x: *mut c_double,
    y: *mut c_double,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getvertex(default_project(), index, vertex, x, y) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetvertex(
    index: c_int,
    vertex: c_int,
    x: c_double,
    y: c_double,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setvertex(default_project(), index, vertex, x, y) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetvertices(
    index: c_int,
    x: *mut c_double,
    y: *mut c_double,
    count: c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setvertices(default_project(), index, x, y, count) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetpumptype(link_index: c_int, pump_type: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getpumptype(default_project(), link_index, pump_type) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetheadcurveindex(link_index: c_int, curve_index: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getheadcurveindex(default_project(), link_index, curve_index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetheadcurveindex(link_index: c_int, curve_index: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setheadcurveindex(default_project(), link_index, curve_index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENaddpattern(id: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_addpattern(default_project(), id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENdeletepattern(index: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_deletepattern(default_project(), index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetpatternindex(id: *const c_char, index: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getpatternindex(default_project(), id, index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetpatternid(index: c_int, id: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getpatternid(default_project(), index, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpatternid(index: c_int, id: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setpatternid(default_project(), index, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetpatternlen(index: c_int, len: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getpatternlen(default_project(), index, len) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetpatternvalue(index: c_int, period: c_int, value: *mut f32) -> c_int {
    let mut v = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode =
        unsafe { crate::EN_getpatternvalue(default_project(), index, period, &raw mut v) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(value, v as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpatternvalue(index: c_int, period: c_int, value: f32) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setpatternvalue(default_project(), index, period, f64::from(value)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetaveragepatternvalue(index: c_int, value: *mut f32) -> c_int {
    let mut v = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe { crate::EN_getaveragepatternvalue(default_project(), index, &raw mut v) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(value, v as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENloadpatternfile(filename: *const c_char, id: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_loadpatternfile(default_project(), filename, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENaddcurve(id: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_addcurve(default_project(), id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENdeletecurve(index: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_deletecurve(default_project(), index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcurveindex(id: *const c_char, index: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcurveindex(default_project(), id, index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcurveid(index: c_int, id: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcurveid(default_project(), index, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcurveid(index: c_int, id: *const c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setcurveid(default_project(), index, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcurvelen(index: c_int, len: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcurvelen(default_project(), index, len) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcurvetype(index: c_int, kind: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcurvetype(default_project(), index, kind) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcurvetype(index: c_int, kind: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setcurvetype(default_project(), index, kind) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcurvevalue(
    curve_index: c_int,
    point_index: c_int,
    x: *mut f32,
    y: *mut f32,
) -> c_int {
    let mut xx = 0.0f64;
    let mut yy = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getcurvevalue(
            default_project(),
            curve_index,
            point_index,
            &raw mut xx,
            &raw mut yy,
        )
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(x, xx as f32) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(y, yy as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcurvevalue(
    curve_index: c_int,
    point_index: c_int,
    x: f32,
    y: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setcurvevalue(
            default_project(),
            curve_index,
            point_index,
            f64::from(x),
            f64::from(y),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENaddcontrol(
    kind: c_int,
    link_index: c_int,
    setting: f32,
    node_index: c_int,
    level: f32,
    index: *mut c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_addcontrol(
            default_project(),
            kind,
            link_index,
            f64::from(setting),
            node_index,
            f64::from(level),
            index,
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENdeletecontrol(index: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_deletecontrol(default_project(), index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcontrol(
    index: c_int,
    kind: *mut c_int,
    link_index: *mut c_int,
    setting: *mut f32,
    node_index: *mut c_int,
    level: *mut f32,
) -> c_int {
    let mut setting2 = 0.0f64;
    let mut level2 = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getcontrol(
            default_project(),
            index,
            kind,
            link_index,
            &raw mut setting2,
            node_index,
            &raw mut level2,
        )
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(setting, setting2 as f32) };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(level, level2 as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcontrol(
    index: c_int,
    kind: c_int,
    link_index: c_int,
    setting: f32,
    node_index: c_int,
    level: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setcontrol(
            default_project(),
            index,
            kind,
            link_index,
            f64::from(setting),
            node_index,
            f64::from(level),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetcontrolenabled(index: c_int, out_enabled: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getcontrolenabled(default_project(), index, out_enabled) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetcontrolenabled(index: c_int, enabled: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setcontrolenabled(default_project(), index, enabled) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENaddrule(rule: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_addrule(default_project(), rule) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENdeleterule(index: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_deleterule(default_project(), index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetrule(
    index: c_int,
    n_premises: *mut c_int,
    n_then_actions: *mut c_int,
    n_else_actions: *mut c_int,
    priority: *mut f32,
) -> c_int {
    let mut priority2 = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getrule(
            default_project(),
            index,
            n_premises,
            n_then_actions,
            n_else_actions,
            &raw mut priority2,
        )
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(priority, priority2 as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetruleID(index: c_int, id: *mut c_char) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getruleID(default_project(), index, id) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetpremise(
    rule_index: c_int,
    premise_index: c_int,
    logop: *mut c_int,
    object: *mut c_int,
    obj_index: *mut c_int,
    variable: *mut c_int,
    relop: *mut c_int,
    status: *mut c_int,
    value: *mut f32,
) -> c_int {
    let mut v = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getpremise(
            default_project(),
            rule_index,
            premise_index,
            logop,
            object,
            obj_index,
            variable,
            relop,
            status,
            &raw mut v,
        )
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(value, v as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpremise(
    rule_index: c_int,
    premise_index: c_int,
    logop: c_int,
    object: c_int,
    obj_index: c_int,
    variable: c_int,
    relop: c_int,
    status: c_int,
    value: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setpremise(
            default_project(),
            rule_index,
            premise_index,
            logop,
            object,
            obj_index,
            variable,
            relop,
            status,
            f64::from(value),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpremiseindex(
    rule_index: c_int,
    premise_index: c_int,
    obj_index: c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setpremiseindex(default_project(), rule_index, premise_index, obj_index) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpremisestatus(
    rule_index: c_int,
    premise_index: c_int,
    status: c_int,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setpremisestatus(default_project(), rule_index, premise_index, status) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetpremisevalue(
    rule_index: c_int,
    premise_index: c_int,
    value: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setpremisevalue(
            default_project(),
            rule_index,
            premise_index,
            f64::from(value),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetthenaction(
    rule_index: c_int,
    action_index: c_int,
    link_index: *mut c_int,
    status: *mut c_int,
    setting: *mut f32,
) -> c_int {
    let mut setting2 = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getthenaction(
            default_project(),
            rule_index,
            action_index,
            link_index,
            status,
            &raw mut setting2,
        )
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(setting, setting2 as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetthenaction(
    rule_index: c_int,
    action_index: c_int,
    link_index: c_int,
    status: c_int,
    setting: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setthenaction(
            default_project(),
            rule_index,
            action_index,
            link_index,
            status,
            f64::from(setting),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetelseaction(
    rule_index: c_int,
    action_index: c_int,
    link_index: *mut c_int,
    status: *mut c_int,
    setting: *mut f32,
) -> c_int {
    let mut setting2 = 0.0f64;
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    let errcode = unsafe {
        crate::EN_getelseaction(
            default_project(),
            rule_index,
            action_index,
            link_index,
            status,
            &raw mut setting2,
        )
    };
    // SAFETY: a caller's output pointer, or null.
    unsafe { out(setting, setting2 as f32) };
    errcode
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetelseaction(
    rule_index: c_int,
    action_index: c_int,
    link_index: c_int,
    status: c_int,
    setting: f32,
) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe {
        crate::EN_setelseaction(
            default_project(),
            rule_index,
            action_index,
            link_index,
            status,
            f64::from(setting),
        )
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetrulepriority(index: c_int, priority: f32) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setrulepriority(default_project(), index, f64::from(priority)) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENgetruleenabled(index: c_int, out_enabled: *mut c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_getruleenabled(default_project(), index, out_enabled) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ENsetruleenabled(index: c_int, enabled: c_int) -> c_int {
    // SAFETY: the caller's arguments, forwarded as the C API takes them.
    unsafe { crate::EN_setruleenabled(default_project(), index, enabled) }
}
