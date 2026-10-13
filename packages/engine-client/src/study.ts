/** Studies the engine runs over many solutions: fire flow, criticality and pipe sizing (ws-study). */

import type { model, SessionRef } from '@waterstudio/core';

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

/** A standard pipe size and its cost per unit length (ADR 0022). */
export interface PipeSize {
  /** In the model's diameter units. */
  diameter: number;
  unitCost: number;
}

/** Limits checked at every report time; unset ones are not checked. */
export interface SizingLimits {
  minPressure?: number;
  maxPressure?: number;
  maxVelocity?: number;
  /** Pipe head loss per 1000 length units. */
  maxHeadloss?: number;
}

/** Fire flows every hydrant must deliver, one at a time (fire-flow repair). */
export interface FireDemand {
  hydrants: string[];
  flow: number;
  residual: number;
  systemMin?: number;
  /** Time into the demand patterns, in seconds. */
  time?: number;
}

export interface SizingOptions {
  /** IDs of the pipes whose diameter may change. */
  pipes: string[];
  sizes: PipeSize[];
  limits?: SizingLimits;
  fire?: FireDemand;
  /** Size the pipes as new, from the smallest size, costing every one. */
  fromSmallest?: boolean;
  /** The most hydraulic solutions the search may run (default 5,000). */
  maxSolutions?: number;
}

export type BreachKind =
  'minPressure' | 'maxPressure' | 'maxVelocity' | 'maxHeadloss' | 'fireResidual' | 'fireSystem';

export interface SizingBreach {
  kind: BreachKind;
  id: string;
  value: number;
  limit: number;
  /** For fire limits: the hydrant flowing when it was worst. */
  hydrant: string | null;
}

export interface SizeChange {
  id: string;
  from: number;
  to: number;
  length: number;
  cost: number;
}

export interface SizingResult {
  changes: SizeChange[];
  cost: number;
  meets: boolean;
  before: SizingBreach[];
  after: SizingBreach[];
  breachesBefore: number;
  breachesAfter: number;
  solutions: number;
  stopped: string | null;
}

/** A study of a model, or of the engine's resident model at a revision (ADR 0020). */
export type StudyRequest =
  | { kind: 'fireFlow'; model: model.Model | SessionRef; options: FireFlowOptions }
  | { kind: 'criticality'; model: model.Model | SessionRef; options: CriticalityOptions }
  | { kind: 'sizing'; model: model.Model | SessionRef; options: SizingOptions };

export type StudyResult<R extends StudyRequest> = R extends { kind: 'fireFlow' }
  ? FireFlowResult[]
  : R extends { kind: 'criticality' }
    ? CriticalityResult[]
    : SizingResult;

/** Any study's result. */
export type AnyStudyResult = FireFlowResult[] | CriticalityResult[] | SizingResult;

/** A study request without its model, for a host that knows which model to study. */
export type StudyCall = {
  [K in StudyRequest['kind']]: Omit<Extract<StudyRequest, { kind: K }>, 'model'>;
}[StudyRequest['kind']];

/** The result of a study call. */
export type StudyCallResult<C extends StudyCall> = StudyResult<Extract<StudyRequest, { kind: C['kind'] }>>;
