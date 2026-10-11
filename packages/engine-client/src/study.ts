/** Studies the engine runs over many solutions: fire flow and criticality (ws-study). */

import type { model } from '@waterstudio/core';

export interface FireFlowOptions {
  hydrants: string[];
  /** Design fire flow, in the model's flow units. */
  flow: number;
  /** Lowest acceptable pressure at the hydrant, in pressure units. */
  residual: number;
  /** Lowest acceptable pressure at every other junction, if checked. */
  systemMin?: number;
  /** Time into the demand patterns, in seconds. */
  time?: number;
  maxFlow?: number;
}

export interface FireFlowResult {
  id: string;
  staticPressure: number | null;
  residualPressure: number | null;
  criticalPressure: number | null;
  criticalNode: string | null;
  availableFlow: number;
  meets: boolean;
  error: string | null;
}

export interface CriticalityOptions {
  /** Link IDs; empty means every pipe. */
  links: string[];
  pressure: number;
}

export interface CriticalityResult {
  id: string;
  nodesBelow: number;
  minPressure: number | null;
  minNode: string | null;
  deficit: number;
  failed: boolean;
  error: string | null;
}

export type StudyRequest =
  | { kind: 'fireFlow'; model: model.Model; options: FireFlowOptions }
  | { kind: 'criticality'; model: model.Model; options: CriticalityOptions };

export type StudyResult<R extends StudyRequest> = R extends { kind: 'fireFlow' }
  ? FireFlowResult[]
  : CriticalityResult[];
