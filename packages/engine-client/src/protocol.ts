/**
 * Messages between the app and engine workers. Model types come from the Rust model
 * through generated declarations (@waterstudio/core), so the two sides cannot drift.
 */

import type { AnyStudyResult, StudyRequest } from './study.ts';
import type { model, SessionRef } from '@waterstudio/core';
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
  /** EPANET's error code, for an error (the code `EN_open` reports for that line). */
  code: number | null;
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

/**
 * A model sent whole, or a reference to the engine's resident model at a revision
 * (ADR 0020), which an engine refuses with a "stale session" error if it holds another.
 */
export type ModelSource = model.Model | SessionRef;

export function isSessionRef(m: ModelSource): m is SessionRef {
  return 'epoch' in m;
}

export interface FilesRequest {
  model: ModelSource;
  /** The input file name the files record. */
  inpName: string;
  /** Clock time in C `ctime` form without the newline. */
  date: string;
  /** Include the hydraulic status log whatever [REPORT] says. */
  statusLog: boolean;
}

/** A multi-species run: the model and an EPANET-MSX input file. */
export interface MsxRequest {
  model: ModelSource;
  /** The MSX input file's text. */
  msx: string;
  /** Its name, for messages. */
  fileName: string;
}

export type EngineRequest =
  | { id: number; kind: 'read-inp'; inp: string }
  | { id: number; kind: 'write-inp'; model: model.Model }
  | { id: number; kind: 'run'; model: ModelSource }
  | { id: number; kind: 'run-hydraulics'; inp: string }
  | { id: number; kind: 'run-files'; request: FilesRequest }
  | { id: number; kind: 'check'; model: ModelSource }
  | { id: number; kind: 'study'; request: StudyRequest }
  | { id: number; kind: 'msx'; request: MsxRequest }
  | { id: number; kind: 'session-open'; snapshot: model.Snapshot }
  | { id: number; kind: 'session-patch'; patch: model.ModelPatch };

export type EngineReply =
  | { kind: 'read-inp'; value: ReadResult }
  | { kind: 'write-inp'; value: string }
  | { kind: 'run'; value: RunResults }
  | { kind: 'run-hydraulics'; value: HydraulicReport }
  | { kind: 'run-files'; value: EpanetFiles }
  | { kind: 'check'; value: string | null }
  | { kind: 'study'; value: AnyStudyResult }
  | { kind: 'msx'; value: RunResults }
  | { kind: 'session-open'; value: null }
  | { kind: 'session-patch'; value: null };

export type EngineResponse =
  { id: number; ok: true; reply: EngineReply; ms: number } | { id: number; ok: false; error: string };

/** The start of the message an engine refuses a request for a model it does not hold with. */
export const STALE_SESSION = 'stale session';

/** The engine failed or refused the input; `message` is EPANET's error text. */
export class EngineError extends Error {
  override name = 'EngineError';
}
