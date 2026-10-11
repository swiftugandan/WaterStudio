/**
 * Messages between the app and engine workers. Model types come from the Rust model
 * through generated declarations (@waterstudio/core), so the two sides cannot drift.
 */

import type { CriticalityResult, FireFlowResult, StudyRequest } from './study.ts';
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

/** EPANET's text report and binary output file for a run. */
export interface EpanetFiles {
  report: string;
  out: Uint8Array;
}

export interface FilesRequest {
  model: model.Model;
  /** The input file name the files record. */
  inpName: string;
  /** Clock time in C `ctime` form without the newline. */
  date: string;
  /** Include the hydraulic status log whatever [REPORT] says. */
  statusLog: boolean;
}

export type EngineRequest =
  | { id: number; kind: 'read-inp'; inp: string }
  | { id: number; kind: 'write-inp'; model: model.Model }
  | { id: number; kind: 'run'; model: model.Model }
  | { id: number; kind: 'run-hydraulics'; inp: string }
  | { id: number; kind: 'run-files'; request: FilesRequest }
  | { id: number; kind: 'check'; model: model.Model }
  | { id: number; kind: 'study'; request: StudyRequest };

export type EngineReply =
  | { kind: 'read-inp'; value: ReadResult }
  | { kind: 'write-inp'; value: string }
  | { kind: 'run'; value: RunResults }
  | { kind: 'run-hydraulics'; value: HydraulicReport }
  | { kind: 'run-files'; value: EpanetFiles }
  | { kind: 'check'; value: string | null }
  | { kind: 'study'; value: FireFlowResult[] | CriticalityResult[] };

export type EngineResponse =
  { id: number; ok: true; reply: EngineReply; ms: number } | { id: number; ok: false; error: string };

/** The engine failed or refused the input; `message` is EPANET's error text. */
export class EngineError extends Error {
  override name = 'EngineError';
}
