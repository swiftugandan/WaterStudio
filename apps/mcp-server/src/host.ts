/**
 * The headless host: a network loaded from an .inp or .wsproj file into a store, the
 * WebAssembly engine, and the proposal queue an agent submits to. Proposals are written
 * beside the network as a file the engineer opens in WaterStudio's Proposals panel;
 * only with `accept` allowed can the agent apply them itself and save the result.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyChangeset,
  draftContext,
  independentCheck,
  proposalsToText,
  type AgentHost,
  type ApplyResult,
  type CheckReport,
  type DraftContext,
  type Proposal,
  type ProposalDraft,
} from '@waterstudio/agents';
import {
  CRITERIA,
  criteriaError,
  emptyCriteria,
  loadModel,
  Store,
  toModel,
  unitSystem,
  type Criteria,
  type Criterion,
  type DocData,
  type Document,
} from '@waterstudio/core';
import type { RunResults, StudyCallResult } from '@waterstudio/engine-client';
import { instantiateEngine, type Engine } from '@waterstudio/engine-client/wasm';
import { isSqlite, readProject } from '@waterstudio/project';

export interface HostOptions {
  /** Let the agent accept its own proposals and save the network. */
  accept: boolean;
  /** Where proposals are written; null to keep them in memory only. */
  proposalsFile: string | null;
  /** The engine's WebAssembly module (defaults to the workspace build). */
  wasm?: Uint8Array;
  /** Design criteria, in place of the project's (an .inp file has none). */
  criteria?: Criteria;
}

export const DEFAULT_WASM = fileURLToPath(
  new URL('../../../packages/engine-client/wasm/ws_wasm.wasm', import.meta.url),
);

/** The default proposals file of a network: `net.inp` → `net.proposals.json`. */
export function proposalsPath(file: string): string {
  return join(dirname(file), `${basename(file, extname(file))}.proposals.json`);
}

/** Design criteria from a JSON file: known limits only, each a number or null. */
export function criteriaFile(path: string): Criteria {
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error(`${path}: the design criteria must be a JSON object.`);
  const out = emptyCriteria();
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!(CRITERIA as readonly string[]).includes(k))
      throw new Error(`${path}: unknown criterion ${k} (known: ${CRITERIA.join(', ')}).`);
    if (x !== null && (typeof x !== 'number' || !Number.isFinite(x)))
      throw new Error(`${path}: ${k} must be a number or null.`);
    out[k as Criterion] = x;
  }
  return out;
}

export class Host {
  readonly store = new Store();
  readonly file: string;
  readonly fileName: string;
  readonly proposals: Proposal[] = [];
  readonly opts: HostOptions;
  /** Input issues EPANET would report (errors) or that look unintended (warnings). */
  readonly issues: string[] = [];
  private readonly engine: Engine;
  private seq = 0;
  readonly ctx: DraftContext;

  private constructor(file: string, engine: Engine, opts: HostOptions) {
    this.file = resolve(file);
    this.fileName = basename(file);
    this.engine = engine;
    this.opts = opts;
    this.ctx = draftContext(this.agentHost());
  }

  static async open(file: string, opts: HostOptions): Promise<Host> {
    const engine = await instantiateEngine(opts.wasm ?? readFileSync(DEFAULT_WASM));
    const host = new Host(file, engine, opts);
    const bytes = readFileSync(file);
    if (isSqlite(bytes)) {
      const { default: init } = await import('@sqlite.org/sqlite-wasm');
      const project = readProject(await init(), bytes);
      loadModel(host.store, project.model);
      const extra: Partial<DocData> = {
        isolationValves: project.isolationValves,
        msx: project.msx,
        ...(project.criteria ? { criteria: project.criteria } : {}),
      };
      host.store.load((tx) => {
        for (const [k, v] of Object.entries(extra)) tx.setDoc(k as keyof DocData, v);
      }, 'Open');
    } else {
      const r = engine.readInp(bytes);
      for (const i of r.issues) host.issues.push(`line ${i.line} [${i.section}] ${i.severity}: ${i.message}`);
      loadModel(host.store, r.model);
    }
    if (opts.criteria) {
      const error = criteriaError(opts.criteria);
      if (error) throw new Error(`The design criteria cannot be used: ${error}`);
      const criteria = opts.criteria;
      host.store.load((tx) => tx.setDoc('criteria', criteria), 'Criteria');
    }
    // The draft must start from the loaded network, not the empty store.
    host.ctx.reset();
    return host;
  }

  private agentHost(): AgentHost {
    const store = this.store;
    return {
      get units() {
        return unitSystem(store.doc.data.options);
      },
      fileName: this.fileName,
      author: 'MCP agent',
      doc: () => this.store.doc,
      period: () => 0,
      run: (doc) => this.solve(doc),
      files: (doc, statusLog) =>
        Promise.resolve(
          this.engine.runFiles({ model: toModel(doc), inpName: this.fileName, date: ctime(), statusLog }),
        ),
      // The engine answers each kind of study with that kind's result.
      study: (doc, call) =>
        Promise.resolve(this.engine.study({ ...call, model: toModel(doc) }) as StudyCallResult<typeof call>),
      submit: (p) => this.submit(p),
    };
  }

  private solve(doc: Document): Promise<RunResults> {
    return Promise.resolve(this.engine.run(toModel(doc)));
  }

  /** Queue a proposal; the independent check runs on it straight after (see `checked`). */
  submit(p: ProposalDraft): string {
    const id = `P${++this.seq}`;
    this.proposals.push({ ...p, id, status: 'pending', created: Date.now() });
    this.writeProposals();
    this.checks.set(id, this.check(id));
    return id;
  }

  private readonly checks = new Map<string, Promise<CheckReport>>();

  /** The independent check of a proposal as submitted. */
  checked(id: string): Promise<CheckReport> {
    return this.checks.get(id) ?? this.check(id);
  }

  /**
   * Check a proposal against the network as it is now and the design criteria, without
   * its author's rationale or evidence (ADR 0021), and record the report with it.
   */
  async check(id: string): Promise<CheckReport> {
    const p = this.proposal(id);
    const report = await independentCheck({
      base: this.store.doc,
      items: p.items,
      criteria: this.store.doc.data.criteria,
      run: (doc) => this.solve(doc),
    });
    p.check = report;
    this.writeProposals();
    return report;
  }

  private proposal(id: string): Proposal {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`There is no proposal ${id}.`);
    return p;
  }

  /**
   * Apply a pending proposal, after checking it again against the network as it is now.
   * One the independent check fails is refused: a person must look at it.
   */
  async accept(id: string): Promise<ApplyResult & { check: CheckReport }> {
    const p = this.proposal(id);
    if (p.status !== 'pending') throw new Error(`${id} is ${p.status} already.`);
    const check = await this.check(id);
    if (check.verdict === 'fail')
      throw new Error(
        `${id} fails the independent check, so it is left for a person to review: ` +
          check.findings
            .filter((f) => f.severity === 'fail')
            .map((f) => f.text)
            .join(' '),
      );
    const r = applyChangeset(this.store, p.items, `Proposal ${id}: ${p.title}`);
    p.status = r.conflicts.length === 0 ? 'accepted' : r.applied > 0 ? 'partial' : 'pending';
    this.writeProposals();
    return { ...r, check };
  }

  /** Write the network as an .inp file (never over the file it was opened from). */
  saveInp(path: string): string {
    const target = resolve(path);
    if (extname(target).toLowerCase() !== '.inp') throw new Error('Save to a file ending in .inp.');
    if (target === this.file) throw new Error('Save to a new file; the original is left as it was.');
    writeFileSync(target, this.engine.writeInp(toModel(this.store.doc)));
    return target;
  }

  private writeProposals(): void {
    if (this.opts.proposalsFile)
      writeFileSync(this.opts.proposalsFile, proposalsToText(this.fileName, this.proposals));
  }
}

/** The clock time as C's `ctime` prints it (UTC), without the newline. */
function ctime(): string {
  const d = new Date();
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    d.getUTCMonth()
  ];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${day} ${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}
