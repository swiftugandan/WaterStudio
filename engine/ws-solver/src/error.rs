/// An error in the network or the solution, with EPANET's error code.
#[derive(Clone, Debug, PartialEq)]
pub struct SolverError {
    pub code: i32,
    pub message: String,
}

impl SolverError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        SolverError {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SolverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "EPANET error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for SolverError {}
