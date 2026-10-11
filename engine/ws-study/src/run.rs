//! A run for the app: every result variable EPANET reports, at every report period,
//! as f32 columns in the model's element order, with a compact binary encoding for
//! the WebAssembly boundary.
//!
//! The variables EPANET's output file holds are taken from it exactly, so the app
//! shows what EPANET's own GUI shows; demand deficit, emitter flow and leakage, which
//! the file does not keep, come from the toolkit's values at each report period.

use serde::Serialize;
use ws_solver::{OUTPUT_LINK_VARIABLES, OUTPUT_NODE_VARIABLES, RunOptions, run_epanet};

/// Node result variables, in column order.
pub const NODE_VARIABLES: [&str; 7] = [
    "demand", "head", "pressure", "quality", "deficit", "emitter", "leakage",
];
/// Link result variables, in column order. `status` holds EPANET's internal status
/// codes (0 XHEAD .. 10 OVERFLOWING); `reaction` is the reaction rate in quality
/// units per day; `friction` the Darcy-Weisbach friction factor.
pub const LINK_VARIABLES: [&str; 9] = [
    "flow", "velocity", "headloss", "quality", "status", "setting", "reaction", "friction",
    "leakage",
];

/// Results of a run. Column `v` of `nodes` holds variable `NODE_VARIABLES[v]` for every
/// period: `nodes[v][period * node_count + i]` is node `i` of the model.
#[derive(Clone, Debug, Default)]
pub struct RunResults {
    pub report_start: i64,
    pub report_step: i64,
    /// Simulation time of each period's solution, in seconds.
    pub times: Vec<i64>,
    pub node_count: usize,
    pub link_count: usize,
    pub nodes: Vec<Vec<f32>>,
    pub links: Vec<Vec<f32>>,
    /// The last hydraulic warning (EPANET's code; 0 if none).
    pub warning: i32,
    /// EPANET's text report and binary output file, when asked for.
    pub report: Option<String>,
    pub out_file: Option<Vec<u8>>,
    /// Multi-species results, when the run included an EPANET-MSX analysis.
    pub msx: Option<crate::msx::MsxResults>,
}

impl RunResults {
    pub fn periods(&self) -> usize {
        self.times.len()
    }
}

/// Put solver-ordered node values into a column in model order.
fn push_nodes(col: &mut Vec<f32>, values: impl IntoIterator<Item = f32>, order: &[usize]) {
    let start = col.len();
    col.resize(start + order.len(), 0.0);
    for (solver_i, v) in values.into_iter().enumerate() {
        if let Some(&mi) = order.get(solver_i) {
            col[start + mi] = v;
        }
    }
}

/// Run a model as EPANET does over its whole duration, keeping each report period.
/// With `files`, also produce EPANET's report and output file.
pub fn run_model(
    model: &ws_model::Model,
    files: Option<&RunOptions>,
) -> Result<RunResults, String> {
    let mut extra_nodes: [Vec<f32>; 3] = Default::default();
    let mut extra_links: Vec<f32> = Vec::new();
    let mut order: Vec<usize> = Vec::new();
    let opts = files.cloned().unwrap_or_default();
    let run = run_epanet(model, &opts, |h| {
        if order.is_empty() {
            order = h.node_model_index().to_vec();
        }
        for (col, values) in
            extra_nodes
                .iter_mut()
                .zip([h.demand_deficits(), h.emitter_flows(), h.node_leakages()])
        {
            push_nodes(col, values.into_iter().map(|v| v as f32), &order);
        }
        extra_links.extend(h.leakages().into_iter().map(|v| v as f32));
    })
    .map_err(|e| e.to_string())?;
    let order = run.node_model_index().to_vec();
    let (nn, nl) = (run.node_count(), run.link_count());
    let periods = run.times().len();
    let mut out = RunResults {
        report_start: run.report_start(),
        report_step: run.report_step(),
        times: run.times().to_vec(),
        node_count: nn,
        link_count: nl,
        warning: run.warning(),
        ..Default::default()
    };
    for v in 0..OUTPUT_NODE_VARIABLES.len() {
        let series = run.node_series(v);
        let mut col = Vec::with_capacity(periods * nn);
        for p in 0..periods {
            push_nodes(
                &mut col,
                series[p * nn..(p + 1) * nn].iter().copied(),
                &order,
            );
        }
        out.nodes.push(col);
    }
    out.nodes.extend(extra_nodes);
    for v in 0..OUTPUT_LINK_VARIABLES.len() {
        out.links.push(run.link_series(v).to_vec());
    }
    out.links.push(extra_links);
    if files.is_some() {
        out.report = run.report().map(str::to_string);
        out.out_file = Some(run.out_file());
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Header<'a> {
    engine: &'a str,
    report_start: i64,
    report_step: i64,
    times: &'a [i64],
    node_count: usize,
    link_count: usize,
    node_variables: &'a [&'a str],
    link_variables: &'a [&'a str],
    /// EPANET's last hydraulic warning code (0 if none).
    warning: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    msx: Option<crate::msx::MsxHeader<'a>>,
}

/// Binary form: u32 header length, the header as UTF-8 JSON, zero padding to a
/// multiple of 4 bytes, then every node column followed by every link column as
/// little-endian f32, `periods * count` values each. With multi-species results the
/// header lists the species and each species' node and link columns follow.
pub fn encode(results: &RunResults, engine: &str) -> Result<Vec<u8>, String> {
    let header = Header {
        engine,
        report_start: results.report_start,
        report_step: results.report_step,
        times: &results.times,
        node_count: results.node_count,
        link_count: results.link_count,
        node_variables: &NODE_VARIABLES,
        link_variables: &LINK_VARIABLES,
        warning: results.warning,
        msx: results.msx.as_ref().map(crate::msx::MsxResults::header),
    };
    let json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    let len = u32::try_from(json.len()).map_err(|_| "header too large".to_string())?;
    let species: Vec<&Vec<f32>> = match &results.msx {
        Some(m) => m
            .columns
            .nodes
            .iter()
            .zip(&m.columns.links)
            .flat_map(|(n, l)| [n, l])
            .collect(),
        None => Vec::new(),
    };
    let values: usize = results
        .nodes
        .iter()
        .chain(&results.links)
        .chain(species.iter().copied())
        .map(Vec::len)
        .sum();
    let mut out = Vec::with_capacity(4 + json.len() + 3 + 4 * values);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&json);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    for col in results
        .nodes
        .iter()
        .chain(&results.links)
        .chain(species.iter().copied())
    {
        for v in col {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    // The reservoir comes first in the file but last in EPANET's node order.
    const NET: &str = "[RESERVOIRS]\n R 200\n[JUNCTIONS]\n J1 100 10\n J2 90 20\n\
[PIPES]\n P1 R J1 1000 12 100\n P2 J1 J2 1000 10 100 0 Closed\n\
[TIMES]\n Duration 2:00\n[OPTIONS]\n Units GPM\n[END]\n";

    fn run() -> RunResults {
        run_model(&ws_io::read_inp(NET).model, None).unwrap()
    }

    #[test]
    fn columns_follow_model_order() {
        let r = run();
        assert_eq!((r.node_count, r.link_count, r.periods()), (3, 2, 3));
        let head = &r.nodes[1];
        assert_eq!(head[0], 200.0); // R, model index 0
        assert!(head[1] < 200.0);
        let flow = &r.links[0];
        // EPANET still serves the cut-off J2 through the closed pipe's tiny conductance
        // (with a huge pressure drop) but reports the closed pipe's flow as zero.
        assert!((flow[0] - 30.0).abs() < 1e-4);
        assert_eq!(flow[1], 0.0);
        assert_eq!(r.links[4][1], 2.0); // P2 closed
    }

    #[test]
    fn encoding_round_trips() {
        let r = run();
        let bytes = encode(&r, "test").unwrap();
        let hlen = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&bytes[4..4 + hlen]).unwrap();
        assert_eq!(header["nodeCount"], 3);
        let start = (4 + hlen).div_ceil(4) * 4;
        let n_values = 7 * 3 * 3 + 9 * 2 * 3;
        assert_eq!(bytes.len(), start + 4 * n_values);
        let head0 = f32::from_le_bytes(bytes[start + 4 * 9..start + 4 * 10].try_into().unwrap());
        assert_eq!(head0, 200.0);
    }
}
