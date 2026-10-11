/**
 * The tool registry: every tool an agent can call, declared once with a JSON Schema,
 * and called through one door that checks arguments and turns failures into results
 * the model can read. The same registry backs the in-app assistant and, later, the
 * MCP server and WebMCP.
 */

import type { Document, UnitSystem } from '@waterstudio/core';
import type { EpanetFiles, RunResults } from '@waterstudio/engine-client';
import { validate, type JsonSchema } from './schema.ts';

/** Results as tools see them. */
export interface RunView {
  results: RunResults;
  /** Handles of the nodes and links in result column order. */
  nodes: Uint32Array;
  links: Uint32Array;
  /** The model has changed since the run. */
  stale: boolean;
}

/** What tools may use: the open model, its results and the engine. */
export interface AgentContext {
  doc: Document;
  units: UnitSystem;
  fileName: string;
  /** The current results, if there are any. */
  results(): RunView | null;
  /** The report time the user is looking at. */
  period(): number;
  /** Run the hydraulic and quality analysis of the model as it is now. */
  analyse(): Promise<RunView>;
  /** EPANET's report and output file for the model as it is now. */
  files(statusLog: boolean): Promise<EpanetFiles>;
}

export type Scope = 'read' | 'analyse' | 'draft';

export interface Tool<A = Record<string, unknown>> {
  name: string;
  description: string;
  input: JsonSchema & { type: 'object' };
  /** read: looks only; analyse: runs the engine but changes nothing; draft: edits a draft. */
  scope: Scope;
  run(args: A, ctx: AgentContext): unknown;
}

export function defineTool<A>(tool: Tool<A>): Tool<A> {
  return tool;
}

/** A tool's answer: data for the model, or an error it can act on. */
export type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never>>();

  constructor(tools: Tool<never>[] = []) {
    for (const t of tools) this.add(t);
  }

  add(t: Tool<never>): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) throw new Error(`bad tool name ${t.name}`);
    if (this.tools.has(t.name)) throw new Error(`tool ${t.name} is already registered`);
    this.tools.set(t.name, t);
  }

  list(scopes: readonly Scope[] = ['read', 'analyse']): Tool<never>[] {
    return [...this.tools.values()].filter((t) => scopes.includes(t.scope));
  }

  get(name: string): Tool<never> | undefined {
    return this.tools.get(name);
  }

  /** Check arguments and run a tool. Never throws. */
  async call(
    name: string,
    args: unknown,
    ctx: AgentContext,
    scopes: readonly Scope[] = ['read', 'analyse'],
  ): Promise<ToolOutcome> {
    const t = this.tools.get(name);
    if (!t) return { ok: false, error: `There is no tool named ${name}.` };
    if (!scopes.includes(t.scope)) return { ok: false, error: `${name} is not allowed in this session.` };
    const problems = validate(t.input, args ?? {});
    if (problems.length > 0) return { ok: false, error: `Invalid arguments: ${problems.join('; ')}.` };
    try {
      const value: unknown = await t.run((args ?? {}) as never, ctx);
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
