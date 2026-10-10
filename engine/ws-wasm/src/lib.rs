//! The WebAssembly boundary. The host copies request bytes into memory obtained from
//! `ws_alloc`, calls an entry point, and reads the reply from the buffer it returns:
//! a little-endian u32 status (0 ok, 1 error), a u32 length, then that many bytes of
//! UTF-8 JSON. The host frees the reply with `ws_free(ptr, 8 + length)`.
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
