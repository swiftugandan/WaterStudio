/**
 * Messages between the app and engine workers. Model types come from the Rust model
 * through generated declarations (@waterstudio/core), so the two sides cannot drift.
 */

import type { model } from '@waterstudio/core';
import type { RunResults } from './results.ts';

/** Results of a hydraulic run as JSON (the parity harness's format); see ws-study. */
export interface HydraulicReport {
  engine: string;
  report_start: number;
  report_step: number;
  nodes: string[];
  links: string[];
  heads: number[][];
  demands: number[][];
  flows: number[][];
}

export interface InpIssue {
  line: number;
  section: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ReadResult {
  model: model.Model;
  issues: InpIssue[];
}

export type EngineRequest =
  | { id: number; kind: 'read-inp'; inp: string }
  | { id: number; kind: 'write-inp'; model: model.Model }
  | { id: number; kind: 'run'; model: model.Model }
  | { id: number; kind: 'run-hydraulics'; inp: string };

export type EngineReply =
  | { kind: 'read-inp'; value: ReadResult }
  | { kind: 'write-inp'; value: string }
  | { kind: 'run'; value: RunResults }
  | { kind: 'run-hydraulics'; value: HydraulicReport };

export type EngineResponse =
  { id: number; ok: true; reply: EngineReply; ms: number } | { id: number; ok: false; error: string };

/** The engine failed or refused the input; `message` is EPANET's error text. */
export class EngineError extends Error {
  override name = 'EngineError';
}
