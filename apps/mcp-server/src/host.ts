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
  proposalsToText,
  type AgentHost,
  type ApplyResult,
  type DraftContext,
  type Proposal,
  type ProposalDraft,
} from '@waterstudio/agents';
import { loadModel, Store, toModel, unitSystem, type DocData } from '@waterstudio/core';
import { instantiateEngine, type Engine } from '@waterstudio/engine-client/wasm';
import { isSqlite, readProject } from '@waterstudio/project';

export interface HostOptions {
  /** Let the agent accept its own proposals and save the network. */
  accept: boolean;
  /** Where proposals are written; null to keep them in memory only. */
  proposalsFile: string | null;
  /** The engine's WebAssembly module (defaults to the workspace build). */
  wasm?: Uint8Array;
}

export const DEFAULT_WASM = fileURLToPath(
  new URL('../../../packages/engine-client/wasm/ws_wasm.wasm', import.meta.url),
);

/** The default proposals file of a network: `net.inp` → `net.proposals.json`. */
export function proposalsPath(file: string): string {
  return join(dirname(file), `${basename(file, extname(file))}.proposals.json`);
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
      const extra: Partial<DocData> = { isolationValves: project.isolationValves, msx: project.msx };
      host.store.load((tx) => {
        for (const [k, v] of Object.entries(extra)) tx.setDoc(k as keyof DocData, v);
      }, 'Open');
    } else {
      const r = engine.readInp(bytes);
      for (const i of r.issues) host.issues.push(`line ${i.line} [${i.section}] ${i.severity}: ${i.message}`);
      loadModel(host.store, r.model);
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
      run: (doc) => Promise.resolve(this.engine.run(toModel(doc))),
      files: (doc, statusLog) =>
        Promise.resolve(
          this.engine.runFiles({ model: toModel(doc), inpName: this.fileName, date: ctime(), statusLog }),
        ),
      submit: (p) => this.submit(p),
    };
  }

  submit(p: ProposalDraft): string {
    const id = `P${++this.seq}`;
    this.proposals.push({ ...p, id, status: 'pending', created: Date.now() });
    this.writeProposals();
    return id;
  }

  accept(id: string): ApplyResult {
    const p = this.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`There is no proposal ${id}.`);
    if (p.status !== 'pending') throw new Error(`${id} is ${p.status} already.`);
    const r = applyChangeset(this.store, p.items, `Proposal ${id}: ${p.title}`);
    p.status = r.conflicts.length === 0 ? 'accepted' : r.applied > 0 ? 'partial' : 'pending';
    this.writeProposals();
    return r;
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
