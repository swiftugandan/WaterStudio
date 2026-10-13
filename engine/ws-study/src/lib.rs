//! Studies over a network. For now: an extended-period hydraulic run reported the
//! way EPANET reports it, shared by the native parity harness and the WebAssembly
//! engine so both produce identical numbers.
//!
//! [`run_hydraulics_inp`] uses WaterStudio's engine (`ws-solver`, a port of
//! OWA-EPANET). [`run_hydraulics_reference`] uses the epanet-rs fork (`ws-hyd`), kept
//! as an independent implementation to benchmark against (ADR 0006).

pub mod msx;
pub mod run;
pub mod sizing;
pub mod studies;

use epanet_rs::model::network::Network;
use epanet_rs::simulation::Simulation;
use serde::Serialize;

/// Results of a hydraulic run at every report period, in the network's own units.
/// Series are indexed `[period][element]`; period k is at
/// `report_start + k * report_step` seconds.
#[derive(Debug, Serialize)]
pub struct HydraulicReport {
    pub engine: &'static str,
    pub report_start: i64,
    pub report_step: i64,
    pub nodes: Vec<String>,
    pub links: Vec<String>,
    pub heads: Vec<Vec<f64>>,
    pub demands: Vec<Vec<f64>>,
    pub flows: Vec<Vec<f64>>,
    /// Node and link water quality, empty when the network has no quality analysis.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub node_quality: Vec<Vec<f64>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub link_quality: Vec<Vec<f64>>,
}

/// Read INP text and solve its hydraulics with WaterStudio's engine.
pub fn run_hydraulics_inp(text: &str) -> Result<HydraulicReport, String> {
    let read = ws_io::read_inp(text);
    if let Some(issue) = read.errors().next() {
        return Err(format!(
            "input: line {} [{}]: {}",
            issue.line, issue.section, issue.message
        ));
    }
    run_hydraulics(&read.model)
}

/// Solve a model's hydraulics over its whole duration with WaterStudio's engine.
pub fn run_hydraulics(model: &ws_model::Model) -> Result<HydraulicReport, String> {
    let r = ws_solver::simulate(model).map_err(|e| e.to_string())?;
    Ok(HydraulicReport {
        engine: concat!("waterstudio-engine ", env!("CARGO_PKG_VERSION")),
        report_start: r.report_start,
        report_step: r.report_step,
        nodes: r.node_ids,
        links: r.link_ids,
        heads: r.heads,
        demands: r.demands,
        flows: r.flows,
        node_quality: r.node_quality,
        link_quality: r.link_quality,
    })
}

/// Solve INP text with the epanet-rs fork, for benchmarking.
pub fn run_hydraulics_reference(text: &str) -> Result<HydraulicReport, String> {
    let network = Network::from_inp_str(text).map_err(|e| format!("input: {e}"))?;
    let mut sim = Simulation::new(network);
    // Step through every hydraulic event, as EPANET does, rather than jumping
    // straight between report times.
    sim.skip_timesteps = false;
    let result = sim
        .solve_hydraulics(false)
        .map_err(|e| format!("solver: {e}"))?;
    let net = &sim.network;
    let demands = fixed_grade_demands(net, result.demands, &result.flows);
    Ok(HydraulicReport {
        engine: concat!("epanet-rs fork ", env!("CARGO_PKG_VERSION")),
        report_start: 0,
        report_step: net.options.time_options.report_timestep as i64,
        nodes: net.nodes.iter().map(|n| n.id.to_string()).collect(),
        links: net.links.iter().map(|l| l.id.to_string()).collect(),
        heads: result.heads,
        demands,
        flows: result.flows,
        node_quality: Vec::new(),
        link_quality: Vec::new(),
    })
}

/// EPANET reports a reservoir's or tank's "demand" as its net inflow from the
/// network (a source supplying 2 units reports -2). The solver leaves these at
/// zero, so derive them from the link flows of each step.
fn fixed_grade_demands(
    net: &Network,
    mut demands: Vec<Vec<f64>>,
    flows: &[Vec<f64>],
) -> Vec<Vec<f64>> {
    for (row, step_flows) in demands.iter_mut().zip(flows) {
        for (node, d) in net.nodes.iter().zip(row.iter_mut()) {
            if node.is_fixed() {
                *d = 0.0;
            }
        }
        for (link, q) in net.links.iter().zip(step_flows) {
            for (end, sign) in [(link.start_node, -1.0), (link.end_node, 1.0)] {
                let fixed = net.nodes.get(end).is_some_and(|n| n.is_fixed());
                if let (true, Some(d)) = (fixed, row.get_mut(end)) {
                    *d += sign * q;
                }
            }
        }
    }
    demands
}

#[cfg(test)]
#[allow(clippy::panic, clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const TWO_PIPES: &str = "[JUNCTIONS]\n n1 100 1\n n2 100 1\n[RESERVOIRS]\n r 220\n\
[PIPES]\n p1 r n1 100 12 100 0 Open\n p2 n1 n2 100 12 100 0 Open\n\
[OPTIONS]\n Units GPM\n Headloss H-W\n[END]\n";

    #[test]
    fn reservoir_demand_is_negative_supply() -> Result<(), String> {
        let report = run_hydraulics_inp(TWO_PIPES)?;
        let r = report
            .nodes
            .iter()
            .position(|n| n == "r")
            .ok_or("no reservoir")?;
        let supplied = report
            .demands
            .first()
            .and_then(|d| d.get(r))
            .copied()
            .ok_or("no demand")?;
        assert!(
            (supplied + 2.0).abs() < 1e-6,
            "reservoir demand was {supplied}"
        );
        Ok(())
    }

    #[test]
    fn heads_fall_downstream() -> Result<(), String> {
        let report = run_hydraulics_inp(TWO_PIPES)?;
        let h = report.heads.first().ok_or("no heads")?;
        let idx = |id: &str| report.nodes.iter().position(|n| n == id).ok_or("missing");
        let (r, n1, n2) = (idx("r")?, idx("n1")?, idx("n2")?);
        assert!(h[r] > h[n1] && h[n1] > h[n2]);
        Ok(())
    }
}
