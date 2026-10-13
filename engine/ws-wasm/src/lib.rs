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
//! - `ws_session`: the resident model (ADR 0020): open it from a snapshot, patch it, and
//!   run the requests above on it by revision instead of sending the model each time
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

const ENGINE: &str = concat!("waterstudio-engine ", env!("CARGO_PKG_VERSION"));

fn run(m: &ws_model::Model) -> Result<Vec<u8>, String> {
    ws_study::run::run_model(m, None).and_then(|r| ws_study::run::encode(&r, ENGINE))
}

fn check(m: &ws_model::Model) -> Result<Vec<u8>, String> {
    ws_solver::check(m)
        .map_err(|e| e.to_string())
        .map(|()| Vec::new())
}

fn msx(m: &ws_model::Model, req: &MsxOptions) -> Result<Vec<u8>, String> {
    ws_study::msx::run_msx(m, &req.msx, &req.file_name)
        .and_then(|r| ws_study::run::encode(&r, ENGINE))
}

fn study(m: &ws_model::Model, req: &Study) -> Result<Vec<u8>, String> {
    match req {
        Study::FireFlow { options } => ws_study::studies::fire_flow(m, options)
            .and_then(|r| serde_json::to_vec(&r).map_err(|e| e.to_string())),
        Study::Criticality { options } => ws_study::studies::criticality(m, options)
            .and_then(|r| serde_json::to_vec(&r).map_err(|e| e.to_string())),
    }
}

fn files(m: &ws_model::Model, req: &FilesOptions) -> Result<Vec<u8>, String> {
    let opts = ws_solver::RunOptions {
        inp_name: req.inp_name.clone(),
        date: req.date.clone(),
        report: true,
        status_log: req.status_log,
    };
    let r = ws_study::run::run_model(m, Some(&opts))?;
    let report = r.report.unwrap_or_default().into_bytes();
    let n = u32::try_from(report.len()).map_err(|_| "report too large".to_string())?;
    let mut body = n.to_le_bytes().to_vec();
    body.extend_from_slice(&report);
    body.extend_from_slice(&r.out_file.unwrap_or_default());
    Ok(body)
}

/// Read a JSON request.
fn parse<'a, T: serde::Deserialize<'a>>(bytes: &'a [u8], what: &str) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("{what}: {e}"))
}

/// Run a model's hydraulics (model as JSON) and return binary results.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_run(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    reply(parse::<ws_model::Model>(bytes, "model").and_then(|m| run(&m)))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MsxOptions {
    /// The EPANET-MSX input file's text.
    msx: String,
    /// Its name, for messages.
    #[serde(default)]
    file_name: String,
}

#[derive(serde::Deserialize)]
struct MsxRequest {
    model: ws_model::Model,
    #[serde(flatten)]
    options: MsxOptions,
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
    reply(parse::<MsxRequest>(bytes, "request").and_then(|r| msx(&r.model, &r.options)))
}

/// Check a model (JSON) as EPANET's input stage would: an empty reply, or the error.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_check(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    reply(parse::<ws_model::Model>(bytes, "model").and_then(|m| check(&m)))
}

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Study {
    FireFlow {
        options: ws_study::studies::FireFlowOptions,
    },
    Criticality {
        options: ws_study::studies::CriticalityOptions,
    },
}

#[derive(serde::Deserialize)]
struct StudyRequest {
    model: ws_model::Model,
    #[serde(flatten)]
    study: Study,
}

/// Run a study (fire flow or criticality) on a model; the reply is the results as JSON.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_study(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    reply(parse::<StudyRequest>(bytes, "request").and_then(|r| study(&r.model, &r.study)))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesOptions {
    inp_name: String,
    /// The run's clock time as C's `ctime` prints it, without the newline.
    date: String,
    /// Include the hydraulic status log whatever [REPORT] says.
    #[serde(default)]
    status_log: bool,
}

#[derive(serde::Deserialize)]
struct FilesRequest {
    model: ws_model::Model,
    #[serde(flatten)]
    options: FilesOptions,
}

/// Run a model as EPANET's `runepanet` does and return its report and output file.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_run_files(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    reply(parse::<FilesRequest>(bytes, "request").and_then(|r| files(&r.model, &r.options)))
}

// ---- The resident model (ADR 0020) ---------------------------------------------------

thread_local! {
    /// The model this instance holds between requests, kept current by patches.
    static SESSION: std::cell::RefCell<Option<ws_model::Mirror>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(serde::Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Session {
    /// Hold this model from now on.
    Open {
        snapshot: ws_model::Snapshot,
    },
    /// Bring the held model to a later revision.
    Patch {
        patch: ws_model::ModelPatch,
    },
    /// The held model as a snapshot (to carry it to a fresh instance), or `null`.
    Export,
    /// The requests above, on the held model at exactly this revision.
    Run {
        epoch: u32,
        rev: u32,
    },
    Check {
        epoch: u32,
        rev: u32,
    },
    Study {
        epoch: u32,
        rev: u32,
        study: Study,
    },
    Files {
        epoch: u32,
        rev: u32,
        options: FilesOptions,
    },
    Msx {
        epoch: u32,
        rev: u32,
        options: MsxOptions,
    },
}

fn session(cmd: Session) -> Result<Vec<u8>, String> {
    SESSION.with(|cell| {
        let mut held = cell.borrow_mut();
        fn model(
            held: &Option<ws_model::Mirror>,
            epoch: u32,
            rev: u32,
        ) -> Result<&ws_model::Model, String> {
            match held {
                Some(m) => m
                    .expect(epoch, rev)
                    .map(|()| m.model())
                    .map_err(|e| e.to_string()),
                None => Err(format!(
                    "stale session: the engine holds no document, not {epoch} at {rev}"
                )),
            }
        }
        match cmd {
            Session::Open { snapshot } => {
                *held = Some(ws_model::Mirror::open(snapshot).map_err(|e| e.to_string())?);
                Ok(Vec::new())
            }
            Session::Patch { patch } => {
                let Some(m) = held.as_mut() else {
                    return Err("stale session: the engine holds no document".into());
                };
                m.apply(patch).map_err(|e| e.to_string())?;
                Ok(Vec::new())
            }
            Session::Export => match held.as_ref() {
                Some(m) => serde_json::to_vec(&m.snapshot()).map_err(|e| e.to_string()),
                None => Ok(b"null".to_vec()),
            },
            Session::Run { epoch, rev } => run(model(&held, epoch, rev)?),
            Session::Check { epoch, rev } => check(model(&held, epoch, rev)?),
            Session::Study {
                epoch,
                rev,
                study: s,
            } => study(model(&held, epoch, rev)?, &s),
            Session::Files {
                epoch,
                rev,
                options,
            } => files(model(&held, epoch, rev)?, &options),
            Session::Msx {
                epoch,
                rev,
                options,
            } => msx(model(&held, epoch, rev)?, &options),
        }
    })
}

/// The resident model: open, patch or export it, or run a request on it (JSON command,
/// see `Session`). Replies as the matching entry point above; a request for another
/// document or revision than the one held fails with a message starting
/// `stale session`, and the host sends a snapshot again.
///
/// # Safety
/// `ptr..ptr+len` must be readable memory the host wrote.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ws_session(ptr: *const u8, len: usize) -> *mut u8 {
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    reply(parse::<Session>(bytes, "session").and_then(session))
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

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const NET: &str = "[JUNCTIONS]\n J1 100 10\n J2 90 20\n[RESERVOIRS]\n R 200\n\
[PIPES]\n P1 R J1 1000 12 100\n P2 J1 J2 1000 10 100\n\
[TIMES]\n Duration 2:00\n[END]\n";

    fn cmd(json: serde_json::Value) -> Result<Vec<u8>, String> {
        session(serde_json::from_value(json).unwrap())
    }

    #[test]
    fn a_patched_session_runs_as_the_whole_model_does() {
        let mut model = ws_io::read_inp(NET).model;
        let snapshot = ws_model::Snapshot {
            epoch: 1,
            rev: 1,
            model: model.clone(),
            node_slots: vec![0, 1, 2],
            link_slots: vec![0, 1],
        };
        cmd(serde_json::json!({ "op": "open", "snapshot": snapshot })).unwrap();
        assert_eq!(
            cmd(serde_json::json!({ "op": "run", "epoch": 1, "rev": 1 })).unwrap(),
            run(&model).unwrap()
        );

        // Change one pipe's diameter.
        let ws_model::LinkKind::Pipe(p) = &mut model.links[1].kind else {
            panic!()
        };
        p.diameter = 6.0;
        let patch = ws_model::ModelPatch {
            epoch: 1,
            from: 1,
            to: 2,
            links: vec![ws_model::LinkSlot {
                slot: 1,
                link: Some(model.links[1].clone()),
            }],
            ..ws_model::ModelPatch::default()
        };
        cmd(serde_json::json!({ "op": "patch", "patch": patch })).unwrap();
        let resident = cmd(serde_json::json!({ "op": "run", "epoch": 1, "rev": 2 })).unwrap();
        assert_eq!(resident, run(&model).unwrap());

        // The old revision, or another document, is stale.
        let e = cmd(serde_json::json!({ "op": "run", "epoch": 1, "rev": 1 })).unwrap_err();
        assert!(e.starts_with("stale session"), "{e}");
        let e = cmd(serde_json::json!({ "op": "check", "epoch": 2, "rev": 2 })).unwrap_err();
        assert!(e.starts_with("stale session"), "{e}");

        // An export reopens an identical session.
        let exported = cmd(serde_json::json!({ "op": "export" })).unwrap();
        let snap: ws_model::Snapshot = serde_json::from_slice(&exported).unwrap();
        assert_eq!(snap.model, model);
        cmd(serde_json::json!({ "op": "open", "snapshot": snap })).unwrap();
        assert!(cmd(serde_json::json!({ "op": "check", "epoch": 1, "rev": 2 })).is_ok());
    }
}
