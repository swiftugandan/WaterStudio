/**
 * The release gate (PLAN: Phase 4 exit; ADR 0021): limits on a suite's summary, per agent.
 * The baselines are gated too, so a grader that starts accepting wrong work (the null
 * agent passing) or rejecting right work (the reference failing) stops a release as
 * surely as a model that got worse.
 */

import type { SuiteResult } from './harness.ts';

export interface Limits {
  /** Lowest share of runs that pass (0 to 1). */
  minPassRate?: number;
  /** Highest share of runs that pass: for the null baseline, which must pass nothing. */
  maxPassRate?: number;
  /** Lowest share of runs that pass, per category. */
  minCategoryPassRate?: Record<string, number>;
  /** Most proposals that break their task's criteria. */
  maxViolatingProposals?: number;
  /** Most proposals the independent checker fails. */
  maxCheckFailures?: number;
  /** Fewest runs of each task: a gate passed on too few runs proves nothing. */
  minRunsPerTask?: number;
}

export interface Gate {
  /** Limits for the scripted baselines, by name, and for any model under `model`. */
  agents: Record<string, Limits>;
  /** Whether a model must have run for the gate to pass (true for a release). */
  requireModel?: boolean;
}

const BASELINES = new Set(['reference', 'null']);

const KEYS = new Set([
  'minPassRate',
  'maxPassRate',
  'minCategoryPassRate',
  'maxViolatingProposals',
  'maxCheckFailures',
  'minRunsPerTask',
]);

/** A gate read from JSON, refusing anything it does not know (a typo must not pass silently). */
export function readGate(v: unknown): Gate {
  if (typeof v !== 'object' || v === null) throw new Error('The gate must be a JSON object.');
  const g = v as Record<string, unknown>;
  for (const k of Object.keys(g))
    if (k !== 'agents' && k !== 'requireModel' && k !== '$comment')
      throw new Error(`Unknown gate field ${k}.`);
  if (typeof g['agents'] !== 'object' || g['agents'] === null) throw new Error('The gate needs agents.');
  const agents: Record<string, Limits> = {};
  for (const [name, raw] of Object.entries(g['agents'] as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) throw new Error(`Gate for ${name} must be an object.`);
    for (const [k, x] of Object.entries(raw as Record<string, unknown>)) {
      if (!KEYS.has(k)) throw new Error(`Unknown limit ${k} for ${name}.`);
      if (k === 'minCategoryPassRate') {
        if (typeof x !== 'object' || x === null)
          throw new Error(`${name}.${k} must map categories to rates.`);
        for (const [c, r] of Object.entries(x as Record<string, unknown>))
          if (typeof r !== 'number' || r < 0 || r > 1)
            throw new Error(`${name}.${k}.${c} must be between 0 and 1.`);
      } else if (typeof x !== 'number' || !Number.isFinite(x) || x < 0)
        throw new Error(`${name}.${k} must be a number of 0 or more.`);
    }
    agents[name] = raw;
  }
  if (g['requireModel'] !== undefined && typeof g['requireModel'] !== 'boolean')
    throw new Error('requireModel must be true or false.');
  return { agents, ...(g['requireModel'] === true ? { requireModel: true } : {}) };
}

/** The gate's limits for an agent: its own, or `model`'s for any model. */
function limitsFor(gate: Gate, agent: string): Limits | undefined {
  return gate.agents[agent] ?? (BASELINES.has(agent) ? undefined : gate.agents['model']);
}

const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

/** Why the suites fail the gate; empty when they pass. */
export function applyGate(gate: Gate, suites: readonly SuiteResult[]): string[] {
  const out: string[] = [];
  if (gate.requireModel && !suites.some((s) => !BASELINES.has(s.summary.agent)))
    out.push('No model was evaluated, and the gate requires one (is WS_EVAL_API_KEY set?).');
  for (const s of suites) {
    const m = s.summary;
    const l = limitsFor(gate, m.agent);
    if (!l) continue;
    const who = m.agent;
    if (l.minRunsPerTask !== undefined && m.runs < m.tasks * l.minRunsPerTask)
      out.push(`${who}: ${m.runs} runs of ${m.tasks} tasks, fewer than ${l.minRunsPerTask} of each.`);
    if (l.minPassRate !== undefined && m.passRate < l.minPassRate)
      out.push(`${who}: passes ${pct(m.passRate)} of runs, below ${pct(l.minPassRate)}.`);
    if (l.maxPassRate !== undefined && m.passRate > l.maxPassRate)
      out.push(`${who}: passes ${pct(m.passRate)} of runs, above ${pct(l.maxPassRate)}.`);
    for (const [c, min] of Object.entries(l.minCategoryPassRate ?? {})) {
      const r = m.byCategory[c];
      if (!r) out.push(`${who}: no runs in category ${c}.`);
      else if (r.passed / r.runs < min)
        out.push(`${who}: ${c} passes ${r.passed}/${r.runs}, below ${pct(min)}.`);
    }
    if (l.maxViolatingProposals !== undefined && m.violatingProposals > l.maxViolatingProposals)
      out.push(`${who}: ${m.violatingProposals} violating proposals, more than ${l.maxViolatingProposals}.`);
    if (l.maxCheckFailures !== undefined && m.checkFailures > l.maxCheckFailures)
      out.push(
        `${who}: ${m.checkFailures} proposals fail the independent check, more than ${l.maxCheckFailures}.`,
      );
  }
  return out;
}
