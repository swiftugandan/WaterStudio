//! The WebAssembly boundary. The host copies request bytes into memory obtained from
//! `ws_alloc`, calls an entry point, and reads the reply from the buffer it returns:
//! a little-endian u32 status (0 ok, 1 error), a u32 length, then that many bytes of
//! UTF-8 JSON (or binary, for runs). The host frees the reply with
//! `ws_free(ptr, 8 + length)`. On error the body is a UTF-8 message.
//!
//! Entry points:
//! - `ws_read_inp`: .inp text -> `{ model, issues }` (the canonical model as JSON)
//! - `ws_write_inp`: model JSON -> .inp text
//! - `ws_run`: model JSON -> binary results (see `ws_study::run::encode`)
//! - `ws_run_files`: `{ model, inpName, date, statusLog }` JSON -> EPANET's report and output file:
//!   a u32 report length, the report text, then the binary output file
//! - `ws_run_hydraulics_inp`: .inp text -> JSON report (the parity harness's format)
//! - `ws_msx`: `{ model, msx, fileName }` JSON -> binary results with every species added
//!
//! This is the only crate in the workspace allowed `unsafe`, and only here.

#![allow(unsafe_code)]

use std::alloc::{Layout, alloc, dealloc};

/// Allocate `len` bytes for the host to write a request into.
#[unsafe(no_mangle)]
pub extern "C" fn ws_alloc(len: usize) -> *mut u8 {
    match Layout::from_size_align(len.max(1), 8) {
        // SAFETY: the layout has non-zero size.
        Ok(layout) => unsafe { alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// Free a buffer from `ws_alloc` or a reply, given the length it was created with.
///
/// # Safety
/// `ptr` must come from this module's allocator with exactly this `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(len.max(1), 8) {
        // SAFETY: guaranteed by the caller.
        unsafe { dealloc(ptr, layout) }
    }
}

/// Solve the hydraulics of INP text at `ptr..ptr+len`.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_run_hydraulics_inp(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    // Older .inp files are often Latin-1; keep going with replacement characters
    // in names rather than refusing the file.
    let text = String::from_utf8_lossy(bytes);
    let outcome = ws_study::run_hydraulics_inp(&text)
        .and_then(|r| serde_json::to_vec(&r).map_err(|e| e.to_string()));
    reply(outcome)
}

/// Read an .inp file into the canonical model.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_read_inp(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let text = String::from_utf8_lossy(bytes);
    let read = ws_io::read_inp(&text);
    let issues: Vec<serde_json::Value> = read
        .issues
        .iter()
        .map(|i| {
            serde_json::json!({
                "line": i.line,
                "section": i.section,
                "severity": match i.severity {
                    ws_io::Severity::Error => "error",
                    ws_io::Severity::Warning => "warning",
                },
                "code": i.code,
                "message": i.message,
            })
        })
        .collect();
    let body = serde_json::json!({ "model": read.model, "issues": issues });
    reply(serde_json::to_vec(&body).map_err(|e| e.to_string()))
}

/// Write the canonical model (JSON) as .inp text.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_write_inp(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let outcome = serde_json::from_slice::<ws_model::Model>(bytes)
        .map(|m| ws_io::write_inp(&m).into_bytes())
        .map_err(|e| format!("model: {e}"));
    reply(outcome)
}

/// Run a model's hydraulics (model as JSON) and return binary results.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_run(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let outcome = serde_json::from_slice::<ws_model::Model>(bytes)
        .map_err(|e| format!("model: {e}"))
        .and_then(|m| ws_study::run::run_model(&m, None))
        .and_then(|r| {
            ws_study::run::encode(
                &r,
                concat!("waterstudio-engine ", env!("CARGO_PKG_VERSION")),
            )
        });
    reply(outcome)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MsxRequest {
    model: ws_model::Model,
    /// The EPANET-MSX input file's text.
    msx: String,
    /// Its name, for messages.
    #[serde(default)]
    file_name: String,
}

/// Run a model's hydraulics and an EPANET-MSX analysis; binary results as `ws_run`
/// with the species' columns added (see `ws_study::run::encode`). On an input error
/// the message lists each bad line.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_msx(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let outcome = serde_json::from_slice::<MsxRequest>(bytes)
        .map_err(|e| format!("request: {e}"))
        .and_then(|req| ws_study::msx::run_msx(&req.model, &req.msx, &req.file_name))
        .and_then(|r| {
            ws_study::run::encode(
                &r,
                concat!("waterstudio-engine ", env!("CARGO_PKG_VERSION")),
            )
        });
    reply(outcome)
}

/// Check a model (JSON) as EPANET's input stage would: an empty reply, or the error.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_check(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let outcome = serde_json::from_slice::<ws_model::Model>(bytes)
        .map_err(|e| format!("model: {e}"))
        .and_then(|m| ws_solver::check(&m).map_err(|e| e.to_string()))
        .map(|()| Vec::new());
    reply(outcome)
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum StudyRequest {
    #[serde(rename_all = "camelCase")]
    FireFlow {
        model: ws_model::Model,
        options: ws_study::studies::FireFlowOptions,
    },
    #[serde(rename_all = "camelCase")]
    Criticality {
        model: ws_model::Model,
        options: ws_study::studies::CriticalityOptions,
    },
}

/// Run a study (fire flow or criticality) on a model; the reply is the results as JSON.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_study(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let outcome = serde_json::from_slice::<StudyRequest>(bytes)
        .map_err(|e| format!("request: {e}"))
        .and_then(|req| match req {
            StudyRequest::FireFlow { model, options } => {
                ws_study::studies::fire_flow(&model, &options)
                    .and_then(|r| serde_json::to_vec(&r).map_err(|e| e.to_string()))
            }
            StudyRequest::Criticality { model, options } => {
                ws_study::studies::criticality(&model, &options)
                    .and_then(|r| serde_json::to_vec(&r).map_err(|e| e.to_string()))
            }
        });
    reply(outcome)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesRequest {
    model: ws_model::Model,
    inp_name: String,
    /// The run's clock time as C's `ctime` prints it, without the newline.
    date: String,
    /// Include the hydraulic status log whatever [REPORT] says.
    #[serde(default)]
    status_log: bool,
}

/// Run a model as EPANET's `runepanet` does and return its report and output file.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_run_files(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let outcome = serde_json::from_slice::<FilesRequest>(bytes)
        .map_err(|e| format!("request: {e}"))
        .and_then(|req| {
            let opts = ws_solver::RunOptions {
                inp_name: req.inp_name,
                date: req.date,
                report: true,
                status_log: req.status_log,
            };
            ws_study::run::run_model(&req.model, Some(&opts))
        })
        .and_then(|r| {
            let report = r.report.unwrap_or_default().into_bytes();
            let n = u32::try_from(report.len()).map_err(|_| "report too large".to_string())?;
            let mut body = n.to_le_bytes().to_vec();
            body.extend_from_slice(&report);
            body.extend_from_slice(&r.out_file.unwrap_or_default());
            Ok(body)
        });
    reply(outcome)
}

fn reply(outcome: Result<Vec<u8>, String>) -> *mut u8 {
    let (status, body) = match outcome {
        Ok(body) => (0u32, body),
        Err(message) => (1u32, message.into_bytes()),
    };
    let Ok(n) = u32::try_from(body.len()) else {
        return std::ptr::null_mut();
    };
    let total = 8 + body.len();
    let out = ws_alloc(total);
    if out.is_null() {
        return out;
    }
    // SAFETY: `out` has room for `total` bytes.
    unsafe {
        std::ptr::copy_nonoverlapping(status.to_le_bytes().as_ptr(), out, 4);
        std::ptr::copy_nonoverlapping(n.to_le_bytes().as_ptr(), out.add(4), 4);
        std::ptr::copy_nonoverlapping(body.as_ptr(), out.add(8), body.len());
    }
    out
}
