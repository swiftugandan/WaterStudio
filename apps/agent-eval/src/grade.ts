/**
 * Deterministic graders. An answer is checked for the numbers and IDs the engine says
 * are right, never by another model; a proposal is checked by applying it to a copy of
 * the network and running the engine on the result.
 */

import {
  applyChangeset,
  Sandbox,
  touchedIds,
  type CheckReport,
  type Proposal,
  type RunView,
} from '@waterstudio/agents';
import type { Document } from '@waterstudio/core';
import { linkFrame, nodeFrame, type LinkVariable, type NodeVariable } from '@waterstudio/engine-client';
import type { Host } from '@waterstudio/mcp-server/host';

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  ok: boolean;
  content: string;
}

/** What an agent did on one task. */
export interface Transcript {
  /** Everything the agent said, in order. */
  answer: string;
  toolCalls: ToolCall[];
  /** Model calls. */
  steps: number;
  /** Why the session stopped early, if it did. */
  error: string | null;
  proposals: Proposal[];
  ms: number;
}

/** Tools that change the draft or submit it. */
export const EDIT_TOOLS = new Set([
  'set_properties',
  'add_nodes',
  'add_links',
  'delete_elements',
  'submit_proposal',
]);

// ---- Answers -------------------------------------------------------------------------

/** Every number written in a text (thousands separators allowed). */
export function numbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])-?\d+(?:\.\d+)?/g)) {
    const v = Number(m[0].replaceAll(',', ''));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** The text states `expected`, to 0.5 % (and never closer than `abs` is asked for). */
export function hasNumber(text: string, expected: number, abs = 0.05): boolean {
  const tol = Math.max(abs, Math.abs(expected) * 0.005);
  return numbers(text).some((v) => Math.abs(v - expected) <= tol);
}

export function hasInteger(text: string, n: number): boolean {
  return numbers(text).includes(n);
}

/** The text names element `id` as a token of its own. */
export function mentionsId(text: string, id: string): boolean {
  const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])${e}(?![\\w-]|\\.\\d)`).test(text);
}

export function check(name: string, pass: boolean, detail?: string): Check {
  return detail === undefined ? { name, pass } : { name, pass, detail };
}

// ---- Results -------------------------------------------------------------------------

export interface Extreme {
  id: string;
  value: number;
  period: number;
  hours: number;
}

/** The lowest or highest value of a variable over elements of the given kinds and every period. */
export function extreme(
  view: RunView,
  doc: Document,
  table: 'node' | 'link',
  variable: string,
  kinds: string[],
  lowest: boolean,
  periods?: number[],
): Extreme | null {
  const r = view.results;
  const handles = table === 'node' ? view.nodes : view.links;
  let best: Extreme | null = null;
  for (const p of periods ?? r.times.map((_, i) => i)) {
    const f =
      table === 'node'
        ? nodeFrame(r, variable as NodeVariable, p)
        : linkFrame(r, variable as LinkVariable, p);
    handles.forEach((h, i) => {
      if (!doc.has(h) || !kinds.includes(doc.kind(h))) return;
      const v = f[i]!;
      if (!best || (lowest ? v < best.value : v > best.value))
        best = { id: doc.id(h), value: v, period: p, hours: (r.reportStart + p * r.reportStep) / 3600 };
    });
  }
  return best;
}

/** One element's variable at every period. */
export function series(view: RunView, doc: Document, id: string, variable: string): number[] {
  const node = doc.findNode(id);
  const h = node ?? doc.findLink(id);
  if (h === undefined) throw new Error(`no element ${id}`);
  const col = (node !== undefined ? view.nodes : view.links).indexOf(h);
  return view.results.times.map((_, p) =>
    node !== undefined
      ? nodeFrame(view.results, variable as NodeVariable, p)[col]!
      : linkFrame(view.results, variable as LinkVariable, p)[col]!,
  );
}

/** Elements of the kinds whose variable passes a limit at some period. */
export function countBeyond(
  view: RunView,
  doc: Document,
  table: 'node' | 'link',
  variable: string,
  kinds: string[],
  test: (v: number) => boolean,
): Set<string> {
  const out = new Set<string>();
  const handles = table === 'node' ? view.nodes : view.links;
  for (let p = 0; p < view.results.times.length; p++) {
    const f =
      table === 'node'
        ? nodeFrame(view.results, variable as NodeVariable, p)
        : linkFrame(view.results, variable as LinkVariable, p);
    handles.forEach((h, i) => {
      if (doc.has(h) && kinds.includes(doc.kind(h)) && test(f[i]!)) out.add(doc.id(h));
    });
  }
  return out;
}

// ---- Proposals -----------------------------------------------------------------------

export interface Grading {
  host: Host;
  t: Transcript;
  /** The engine's results for a document. */
  run(doc: Document): Promise<RunView>;
  /** The network as the task began, with a proposal applied (a copy). */
  applied(p: Proposal): { doc: Document; conflicts: number };
  /** The independent check of a proposal against the task's design criteria (ADR 0021). */
  checked(p: Proposal): Promise<CheckReport>;
}

export function grading(host: Host, t: Transcript): Grading {
  return {
    host,
    t,
    run: async (doc) => ({
      results: await host.ctx.host.run(doc),
      nodes: Uint32Array.from(doc.nodeHandles()),
      links: Uint32Array.from(doc.linkHandles()),
      stale: false,
    }),
    applied: (p) => {
      const sb = new Sandbox(host.store.doc);
      const r = applyChangeset(sb.store, p.items, p.title);
      return { doc: sb.store.doc, conflicts: r.conflicts.length };
    },
    checked: (p) => host.checked(p.id),
  };
}

/** The last proposal, with checks that there is exactly one and it applies cleanly. */
export function oneProposal(g: Grading, checks: Check[]): { p: Proposal; doc: Document } | null {
  const n = g.t.proposals.length;
  checks.push(check('submits one proposal', n === 1, `${n} submitted`));
  const p = g.t.proposals.at(-1);
  if (!p) return null;
  const { doc, conflicts } = g.applied(p);
  checks.push(check('proposal applies cleanly', conflicts === 0, `${conflicts} conflicts`));
  return { p, doc };
}

/** IDs a proposal touches, as `node:ID` and `link:ID`. */
export function touched(p: Proposal): string[] {
  const t = touchedIds(p.items);
  return [...[...t.node].map((id) => `node:${id}`), ...[...t.link].map((id) => `link:${id}`)].sort();
}

/** Pipe diameter changes in a proposal: whether all are enlargements, and inch-feet added. */
export function pipeUpsizing(doc: Document, p: Proposal): { only: boolean; cost: number; pipes: string[] } {
  let only = true;
  let cost = 0;
  const pipes: string[] = [];
  for (const it of p.items) {
    if (it.op !== 'set' || it.field !== 'diameter' || it.kind !== 'pipe') {
      only = false;
      continue;
    }
    const from = Number(it.from);
    const to = Number(it.to);
    if (!(to > from)) only = false;
    const h = doc.findLink(it.id);
    cost += (to - from) * (h === undefined ? 0 : doc.num(h, 'length'));
    pipes.push(it.id);
  }
  return { only: only && pipes.length > 0, cost, pipes };
}
