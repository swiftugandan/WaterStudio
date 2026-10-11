/**
 * Types shared by the engine's WebAssembly boundary (`engine/ws-wasm`), the worker and
 * the client. They mirror the Rust structs serialised by serde; keep them in step with
 * `engine/ws-study/src/lib.rs`.
 */

/** Results of a hydraulic run at every report period, in the network's own units. */
export interface HydraulicReport {
  engine: string;
  /** Seconds from the start of the simulation to the first report period. */
  report_start: number;
  /** Seconds between report periods. */
  report_step: number;
  /** Node IDs in engine order: junctions, then tanks and reservoirs. */
  nodes: string[];
  /** Link IDs in input order. */
  links: string[];
  /** `[period][node]` hydraulic head. */
  heads: number[][];
  /** `[period][node]` demand; a tank's or reservoir's is its net inflow. */
  demands: number[][];
  /** `[period][link]` flow; zero for closed links. */
  flows: number[][];
}

export type EngineRequest = { id: number; kind: 'run-hydraulics'; inp: string };

export type EngineResponse =
  | { id: number; ok: true; report: HydraulicReport; solveMs: number }
  | { id: number; ok: false; error: string };

/** The engine failed or refused the network; `message` is EPANET's error text. */
export class EngineError extends Error {
  override name = 'EngineError';
}
