/**
 * Application state outside React: the document store, selection, the active tool,
 * engine runs and how results are shown. Components subscribe through `useApp` and
 * re-render when it changes; the viewport subscribes directly for speed.
 */

import { loadModel, Store, toModel, unitSystem, type model, type UnitSystem } from '@waterstudio/core';
import {
  EngineClient,
  type InpIssue,
  type LinkVariable,
  type NodeVariable,
  type RunResults,
} from '@waterstudio/engine-client';
import type { RampName, RendererStatus } from '@waterstudio/render';
import { Emitter } from './emitter.ts';
import type { Prefs } from './prefs.ts';
import type { ViewApi } from './view.ts';

export type Tool = 'select' | 'pan' | 'junction' | 'reservoir' | 'tank' | 'pipe' | 'pump' | 'valve';

export interface Message {
  time: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface RunState {
  status: 'idle' | 'running' | 'done' | 'error';
  results?: RunResults;
  /** Store revision the results were computed at. */
  rev?: number;
  /** Handles of the nodes and links in result column order. */
  nodes?: Uint32Array;
  links?: Uint32Array;
  ms?: number;
  error?: string;
}

export interface MapTheme {
  node: NodeVariable | null;
  link: LinkVariable | null;
  ramp: RampName;
}

export class AppState extends Emitter {
  store = new Store();
  /** Bumped when the store is replaced (new file), so views rebind. */
  generation = 0;
  fileName = 'Untitled.inp';
  savedRev = 0;
  selection = new Set<number>();
  hover: number | null = null;
  tool: Tool = 'select';
  run: RunState = { status: 'idle' };
  period = 0;
  mapTheme: MapTheme = { node: 'pressure', link: 'flow', ramp: 'viridis' };
  messages: Message[] = [];
  renderer: RendererStatus = { backend: null };
  cursor: [number, number] | null = null;
  paletteOpen = false;
  view: ViewApi | null = null;
  /** Panels the user has open, by id. */
  panels = new Set(['browser', 'properties', 'results', 'messages']);
  readonly engine: EngineClient;
  readonly prefs: Prefs;
  private unsubscribeStore: () => void = () => {};

  constructor(prefs: Prefs, engine = new EngineClient({ workers: 1 })) {
    super();
    this.prefs = prefs;
    this.engine = engine;
    this.bindStore();
  }

  private bindStore(): void {
    this.unsubscribeStore();
    this.unsubscribeStore = this.store.subscribe((c) => {
      // Drop selections of elements that no longer exist.
      if (c.structural) for (const h of this.selection) if (!this.store.doc.has(h)) this.selection.delete(h);
      this.emit();
    });
  }

  get units(): UnitSystem {
    return unitSystem(this.store.doc.data.options);
  }

  get dirty(): boolean {
    return this.store.rev !== this.savedRev;
  }

  /** Results exist but the model has changed since they were computed. */
  get stale(): boolean {
    return this.run.status === 'done' && this.run.rev !== this.store.rev;
  }

  log(level: Message['level'], text: string): void {
    this.messages = [...this.messages.slice(-499), { time: Date.now(), level, text }];
    this.emit();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit();
  }

  select(handles: Iterable<number>, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    if (mode === 'replace') this.selection = new Set(handles);
    else {
      const next = new Set(this.selection);
      for (const h of handles) {
        if (mode === 'toggle' && next.has(h)) next.delete(h);
        else next.add(h);
      }
      this.selection = next;
    }
    this.emit();
  }

  setHover(h: number | null): void {
    if (this.hover === h) return;
    this.hover = h;
    this.emit();
  }

  setPeriod(p: number): void {
    const n = this.run.results?.times.length ?? 1;
    this.period = Math.max(0, Math.min(n - 1, p));
    this.emit();
  }

  setMapTheme(t: Partial<MapTheme>): void {
    this.mapTheme = { ...this.mapTheme, ...t };
    this.emit();
  }

  /** Replace the document with a model (opening a file or a sample). */
  openModel(m: model.Model, name: string, issues: InpIssue[] = []): void {
    const store = new Store();
    loadModel(store, m);
    this.store = store;
    this.generation++;
    this.bindStore();
    this.fileName = name;
    this.savedRev = store.rev;
    this.selection = new Set();
    this.hover = null;
    this.run = { status: 'idle' };
    this.period = 0;
    const errors = issues.filter((i) => i.severity === 'error').length;
    this.log(
      errors > 0 ? 'warning' : 'info',
      `Opened ${name}: ${store.doc.nodes.liveCount} nodes, ${store.doc.links.liveCount} links` +
        (issues.length > 0 ? `, ${issues.length} input issues` : ''),
    );
    for (const i of issues.slice(0, 50)) {
      this.log(i.severity === 'error' ? 'error' : 'warning', `Line ${i.line} [${i.section}]: ${i.message}`);
    }
    this.emit();
  }

  newModel(): void {
    this.openModel(emptyModel(), 'Untitled.inp');
  }

  async openInp(text: string, name: string): Promise<void> {
    const { value } = await this.engine.readInp(text);
    this.openModel(value.model, name, value.issues);
  }

  async saveInp(): Promise<string> {
    const { value } = await this.engine.writeInp(toModel(this.store.doc));
    this.savedRev = this.store.rev;
    this.emit();
    return value;
  }

  async runHydraulics(): Promise<void> {
    if (this.run.status === 'running') return;
    const rev = this.store.rev;
    const doc = this.store.doc;
    const nodes = Uint32Array.from(doc.nodeHandles());
    const links = Uint32Array.from(doc.linkHandles());
    this.run = { ...this.run, status: 'running' };
    this.emit();
    try {
      const { value, ms } = await this.engine.run(toModel(doc));
      this.run = { status: 'done', results: value, rev, nodes, links, ms };
      this.period = Math.min(this.period, value.times.length - 1);
      this.log('info', `Hydraulics solved: ${value.times.length} report periods in ${ms.toFixed(0)} ms.`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.run = { status: 'error', error };
      this.log('error', `Run failed: ${error}`);
    }
    this.emit();
  }
}

export function emptyModel(): model.Model {
  const section = (lines: string[][] = []): model.KeywordSection => ({
    lines: lines.map((tokens) => ({ tokens, comment: null })),
  });
  return {
    title: [],
    nodes: [],
    links: [],
    patterns: [],
    curves: [],
    controls: [],
    rules: [],
    options: section([
      ['Units', 'GPM'],
      ['Headloss', 'H-W'],
    ]),
    times: section([['Duration', '0']]),
    report: section(),
    energy: section(),
    reactions: section(),
    backdrop: section(),
    labels: [],
    extraSections: [],
  };
}
