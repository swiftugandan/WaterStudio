//! A run with multi-species water quality for the app: the hydraulic results of
//! [`crate::run::run_model`] plus every species at every report period, from
//! WaterStudio's port of EPANET-MSX (`ws-msx`).

use serde::Serialize;
use ws_msx::{Columns, Msx, SpeciesInfo, WALL};

use crate::run::{RunResults, run_model};

/// Species results and what EPANET-MSX writes about the run.
#[derive(Clone, Debug, Default)]
pub struct MsxResults {
    pub title: String,
    pub species: Vec<SpeciesInfo>,
    pub columns: Columns,
    /// The MSX report requested by the input's [REPORT] section (may be empty).
    pub report: String,
    /// Lines written while opening the input.
    pub messages: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeciesHeader<'a> {
    id: &'a str,
    kind: &'static str,
    units: &'a str,
    precision: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MsxHeader<'a> {
    title: &'a str,
    species: Vec<SpeciesHeader<'a>>,
    report: &'a str,
    messages: &'a [String],
}

impl MsxResults {
    pub(crate) fn header(&self) -> MsxHeader<'_> {
        MsxHeader {
            title: &self.title,
            species: self
                .species
                .iter()
                .map(|s| SpeciesHeader {
                    id: &s.id,
                    kind: if s.kind == WALL { "wall" } else { "bulk" },
                    units: &s.units,
                    precision: s.precision,
                })
                .collect(),
            report: &self.report,
            messages: &self.messages,
        }
    }
}

/// Error text for an MSX failure: the code's message and the input errors with
/// their lines, one per line.
fn describe(e: &ws_msx::MsxError) -> String {
    let lines: Vec<&str> = e
        .messages
        .iter()
        .map(|s| s.trim_end())
        .filter(|s| !s.is_empty())
        .collect();
    if lines.is_empty() {
        ws_msx::error_message(e.code).to_string()
    } else {
        lines.join("\n")
    }
}

/// Run a model's hydraulics and an MSX analysis over them. Every report period is
/// kept whatever statistic the model asks for.
pub fn run_msx(model: &ws_model::Model, msx: &str, file_name: &str) -> Result<RunResults, String> {
    let mut results = run_model(model, None)?;
    let mut run = Msx::from_model(model, msx, file_name).map_err(|e| describe(&e))?;
    run.report_series();
    run.solve().map_err(|e| describe(&e))?;
    let columns = run.columns();
    if columns.periods != results.periods() {
        return Err(format!(
            "the MSX analysis reported {} periods where the hydraulics reported {}",
            columns.periods,
            results.periods()
        ));
    }
    results.msx = Some(MsxResults {
        title: run.title().to_string(),
        species: run.species(),
        columns,
        report: run.report().map_err(|e| describe(&e))?,
        messages: run.messages().to_vec(),
    });
    Ok(results)
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const NET: &str = "[RESERVOIRS]\n R 200\n[JUNCTIONS]\n J1 100 10\n J2 90 20\n\
[PIPES]\n P1 R J1 1000 12 100\n P2 J1 J2 1000 10 100\n\
[TIMES]\n Duration 4:00\n Statistic AVERAGE\n[OPTIONS]\n Units GPM\n[END]\n";

    const MSX: &str = "[SPECIES]\nBULK CL MG\nWALL B UG\n[PIPES]\nRATE CL -0.5*CL\nRATE B 0.1\n\
[TANKS]\nRATE CL -0.5*CL\n[QUALITY]\nNODE R CL 1.0\n[REPORT]\nNODES ALL\nSPECIES CL YES\n";

    #[test]
    fn species_columns_follow_model_order_and_every_period() {
        let model = ws_io::read_inp(NET).model;
        let r = run_msx(&model, MSX, "t.msx").unwrap();
        let m = r.msx.as_ref().unwrap();
        assert_eq!(m.species.len(), 2);
        assert_eq!(
            m.columns.periods, 5,
            "every period despite the AVERAGE statistic"
        );
        let cl = &m.columns.nodes[0];
        // The reservoir is model node 0 and keeps its concentration.
        assert_eq!(cl[4 * 3], 1.0);
        // J1 has received decayed water; J2, further on, not yet.
        assert!(cl[4 * 3 + 1] > 0.0 && cl[4 * 3 + 1] < 1.0, "{cl:?}");
        // Wall species are zero at nodes.
        assert!(m.columns.nodes[1].iter().all(|&v| v == 0.0));
        assert!(m.report.contains("<<< Node J2 >>>"));
        let bytes = crate::run::encode(&r, "ws").unwrap();
        let hlen = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
        let header = std::str::from_utf8(&bytes[4..4 + hlen]).unwrap();
        assert!(
            header.contains(r#""species":[{"id":"CL","kind":"bulk","units":"MG/L","precision":2}"#),
            "{header}"
        );
    }

    #[test]
    fn input_errors_come_back_with_their_lines() {
        let model = ws_io::read_inp(NET).model;
        let e = run_msx(
            &model,
            "[SPECIES]\nBULK CL MG\n[PIPES]\nRATE CL -k*CL\n",
            "t.msx",
        )
        .unwrap_err();
        assert!(
            e.contains("Error 409 (illegal math expression) at line 4 of [PIPE] section:"),
            "{e}"
        );
        assert!(e.contains("Error 506"), "{e}");
    }
}
