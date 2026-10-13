//! Writes the model's TypeScript declarations to packages/core/src/generated/model.ts.
//!
//! `cargo test -p ws-model --features ts`; CI fails if the committed file is stale.

#![cfg(feature = "ts")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::PathBuf;
use ts_rs::{Config, TS};

#[test]
fn export_typescript() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/generated");
    let cfg = Config::new()
        .with_out_dir(&dir)
        .with_import_extension(Some("ts"));
    ws_model::Model::export_all(&cfg).unwrap();
    ws_model::Snapshot::export_all(&cfg).unwrap();
    ws_model::ModelPatch::export_all(&cfg).unwrap();
    // ts-rs imports a file's own types when several share it; drop that line.
    let path = dir.join("model.ts");
    let text = std::fs::read_to_string(&path).unwrap();
    let text: String = text
        .lines()
        .filter(|l| !(l.starts_with("import type") && l.ends_with("from \"./model.ts\";")))
        .map(|l| format!("{l}\n"))
        .collect();
    assert!(text.contains("export type Model"));
    std::fs::write(&path, text).unwrap();
}
