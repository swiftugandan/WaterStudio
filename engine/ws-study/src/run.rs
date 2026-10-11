//! A hydraulic run for the app: every result variable EPANET reports, at every report
//! period, as f32 columns in the model's element order, with a compact binary encoding
//! for the WebAssembly boundary.

use serde::Serialize;
use ws_solver::Hydraulics;

/// Node result variables, in column order.
pub const NODE_VARIABLES: [&str; 6] = [
    "demand", "head", "pressure", "deficit", "emitter", "leakage",
];
/// Link result variables, in column order. `status` holds EPANET's internal status
/// codes (0 XHEAD .. 10 OVERFLOWING).
pub const LINK_VARIABLES: [&str; 6] = [
    "flow", "velocity", "headloss", "status", "setting", "leakage",
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
}

impl RunResults {
    pub fn periods(&self) -> usize {
        self.times.len()
    }
}

/// Solve a model's hydraulics over its whole duration, keeping each report period the
/// way EPANET's output file does.
pub fn run_model(model: &ws_model::Model) -> Result<RunResults, String> {
    let mut h = Hydraulics::new(model).map_err(|e| e.to_string())?;
    let (rstart, rstep, _) = h.report_times();
    let order: Vec<usize> = h.node_model_index().to_vec();
    let (nn, nl) = (h.node_count(), h.link_count());
    let mut out = RunResults {
        report_start: rstart,
        report_step: rstep,
        node_count: nn,
        link_count: nl,
        nodes: vec![Vec::new(); NODE_VARIABLES.len()],
        links: vec![Vec::new(); LINK_VARIABLES.len()],
        ..Default::default()
    };
    let mut rtime = rstart;
    loop {
        let t = h.run().map_err(|e| e.to_string())?;
        if t >= rtime {
            out.times.push(t);
            let node_cols = [
                h.demands(),
                h.heads(),
                h.pressures(),
                h.demand_deficits(),
                h.emitter_flows(),
                h.node_leakages(),
            ];
            for (col, values) in out.nodes.iter_mut().zip(node_cols) {
                let start = col.len();
                col.resize(start + nn, 0.0);
                for (solver_i, v) in values.into_iter().enumerate() {
                    if let Some(&mi) = order.get(solver_i) {
                        col[start + mi] = v as f32;
                    }
                }
            }
            let status: Vec<f64> = h.statuses().into_iter().map(|s| s as u8 as f64).collect();
            let link_cols = [
                h.flows(),
                h.velocities(),
                h.unit_headlosses(),
                status,
                h.settings(),
                h.leakages(),
            ];
            for (col, values) in out.links.iter_mut().zip(link_cols) {
                col.extend(values.into_iter().map(|v| v as f32));
            }
            rtime += rstep;
        }
        if h.advance() <= 0 {
            break;
        }
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
}

/// Binary form: u32 header length, the header as UTF-8 JSON, zero padding to a
/// multiple of 4 bytes, then every node column followed by every link column as
/// little-endian f32, `periods * count` values each.
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
    };
    let json = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    let len = u32::try_from(json.len()).map_err(|_| "header too large".to_string())?;
    let values: usize = results
        .nodes
        .iter()
        .chain(&results.links)
        .map(Vec::len)
        .sum();
    let mut out = Vec::with_capacity(4 + json.len() + 3 + 4 * values);
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&json);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    for col in results.nodes.iter().chain(&results.links) {
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
        run_model(&ws_io::read_inp(NET).model).unwrap()
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
        assert_eq!(r.links[3][1], 2.0); // P2 closed
    }

    #[test]
    fn encoding_round_trips() {
        let r = run();
        let bytes = encode(&r, "test").unwrap();
        let hlen = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&bytes[4..4 + hlen]).unwrap();
        assert_eq!(header["nodeCount"], 3);
        let start = (4 + hlen).div_ceil(4) * 4;
        let n_values = 6 * 3 * 3 + 6 * 2 * 3;
        assert_eq!(bytes.len(), start + 4 * n_values);
        let head0 = f32::from_le_bytes(bytes[start + 4 * 9..start + 4 * 10].try_into().unwrap());
        assert_eq!(head0, 200.0);
    }
}
