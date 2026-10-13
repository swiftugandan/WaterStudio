//! EPANET `.inp` files to and from the canonical model.
//!
//! [`read_inp`] follows OWA-EPANET 2.3.5's input parser (`input2.c`, `input3.c`) line
//! for line: the same tokeniser, the same keyword matching, the same defaults and the
//! same order-dependent resolution of ranges. Problems are reported as [`Issue`]s
//! rather than failing the whole file, so an editor can open and fix a broken model;
//! the errors among them are exactly EPANET's ([`check_inp`]), with its codes.
//!
//! [`read_as_epanet`] is what the toolkit's `EN_openX` keeps of a file with errors.
//!
//! [`write_inp`] writes every value explicitly and exactly, so the written file solves
//! identically to the model in EPANET and reads back to an equal model.

mod check;
mod reader;
mod tokens;
mod writer;

pub use check::{Check, InputError, RuleError, check_inp, getfloat, input_error_text};
pub use reader::{read_as_epanet, read_inp};
pub use tokens::{Line, tokenize};
pub use writer::write_inp;

/// Something wrong with an input line. EPANET would refuse the file on an error;
/// the editor opens it and shows the issue.
#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    /// 1-based line number in the file.
    pub line: usize,
    pub section: String,
    pub severity: Severity,
    /// EPANET's error code, for an error.
    pub code: Option<u16>,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    /// EPANET would report an input error and not run.
    Error,
    /// EPANET accepts it, but something is probably not what the author meant.
    Warning,
}

/// The result of reading a file: the model and everything noticed along the way.
#[derive(Clone, Debug)]
pub struct ReadResult {
    pub model: ws_model::Model,
    pub issues: Vec<Issue>,
}

impl ReadResult {
    pub fn errors(&self) -> impl Iterator<Item = &Issue> {
        self.issues.iter().filter(|i| i.severity == Severity::Error)
    }
}
