/**
 * Application state outside React: the document store, selection, the active tool,
 * engine runs and how results are shown. Components subscribe through `useApp` and
 * re-render when it changes; the viewport subscribes directly for speed.
 */

import { readDefaults, saveDefaults, type Defaults } from './defaults.ts';
import { planLengthOf } from './geometry.ts';
import type { CalibrationData, CalibrationVariable } from './calibration.ts';
import {
  loadModel,
  Scenarios,
  Store,
  toModel,
  unitSystem,
  type model,
  type PropertyClip,
  type UnitSystem,
} from '@waterstudio/core';
import {
  EngineClient,
  type EpanetFiles,
  type InpIssue,
  type LinkVariable,
  type NodeVariable,
  type RunResults,
} from '@waterstudio/engine-client';
import type { RampName, RendererStatus } from '@waterstudio/render';
import { Conversation } from './assistant.ts';
import { Emitter } from './emitter.ts';
import { ctime } from './time.ts';
import type { GraphSpec } from './graphs.ts';
import type { Prefs } from './prefs.ts';
import type { ViewApi } from './view.ts';

export type Tool =
  'select' | 'pan' | 'junction' | 'reservoir' | 'tank' | 'pipe' | 'pump' | 'valve' | 'label' | 'backdrop';

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

/** EPANET's report and output file for one revision of the model. */
export interface FilesState {
  rev: number;
  statusLog: boolean;
  status: 'running' | 'done' | 'error';
  files?: EpanetFiles;
  /** Link handles in the order the files list links. */
  links?: Uint32Array;
  error?: string;
}

export interface MapTheme {
  node: NodeVariable | null;
  link: LinkVariable | null;
  ramp: RampName;
  /** Legend intervals set by hand, by `table:variable` (EPANET's legend editor). */
  breaks?: Record<string, number[]>;
}

export { ctime };

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
  /** EPANET's files, by whether the status log was asked for. */
  files: Partial<Record<'report' | 'status', FilesState>> = {};
  /** Measurements loaded for the calibration report, by variable. */
  calibration: Partial<Record<CalibrationVariable, CalibrationData>> = {};
  period = 0;
  mapTheme: MapTheme = { node: 'pressure', link: 'flow', ramp: 'viridis' };
  messages: Message[] = [];
  renderer: RendererStatus = { backend: null };
  cursor: [number, number] | null = null;
  paletteOpen = false;
  /** Whether the street map is drawn under the network (set by the map view). */
  basemapShown = false;
  /** A backdrop image loaded this session (EPANET records only its file name). */
  backdrop: { url: string; name: string } | null = null;
  view: ViewApi | null = null;
  private graphRequests: GraphSpec[] = [];
  /** Panels the user has open, by id. */
  panels = new Set(['browser', 'properties', 'results', 'messages']);
  private panelFocus: string | null = null;
  /** Alternatives of this network (the scenario manager). */
  scenarios!: Scenarios;
  /** Properties copied with Edit › Copy, for pasting onto elements of the same kind. */
  clipboard: PropertyClip | null = null;
  /** Defaults for new elements (Project › Defaults). */
  defaults: Defaults = readDefaults();
  /** Bumped to ask the query panel to focus its Find box. */
  findRequest = 0;
  readonly engine: EngineClient;
  readonly prefs: Prefs;
  /** The assistant conversation (kept when its panel closes). */
  readonly conversation: Conversation;
  private unsubscribeStore: () => void = () => {};

  constructor(prefs: Prefs, engine = new EngineClient({ workers: 1 })) {
    super();
    this.prefs = prefs;
    this.engine = engine;
    this.conversation = new Conversation(this);
    this.bindStore();
  }

  private bindStore(): void {
    this.unsubscribeStore();
    (this.scenarios as Scenarios | undefined)?.dispose();
    this.scenarios = new Scenarios(this.store);
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

  /** Open a graph in a new panel. */
  openGraph(spec: GraphSpec): void {
    this.graphRequests.push(spec);
    this.emit();
  }

  /** Graphs asked for since the last call (the dock opens them). */
  takeGraphRequests(): GraphSpec[] {
    const r = this.graphRequests;
    this.graphRequests = [];
    return r;
  }

  setCalibration(variable: CalibrationVariable, data: CalibrationData | null): void {
    const next: typeof this.calibration = {};
    for (const [k, v] of Object.entries(this.calibration) as [CalibrationVariable, CalibrationData][])
      if (k !== variable) next[k] = v;
    if (data) next[variable] = data;
    this.calibration = next;
    this.emit();
  }

  /** With auto-length on, the plan length of a link for edits; otherwise undefined. */
  get lengthOf(): ((link: number) => number | undefined) | undefined {
    return this.prefs.autoLength === 'on' ? planLengthOf(this.store.doc, this.units.si) : undefined;
  }

  setDefaults(d: Defaults): void {
    this.defaults = d;
    saveDefaults(d);
    this.emit();
  }

  /** Switch scenario (null for the base network). */
  activateScenario(id: string | null): void {
    this.scenarios.activate(id);
    const name = id === null ? 'the base network' : (this.scenarios.get(id)?.name ?? id);
    this.log('info', `Showing ${name}. Edits to properties now belong to it.`);
    this.emit();
  }

  /** Open a panel (if closed) and bring it to the front. */
  showPanel(id: string): void {
    if (!this.panels.has(id)) this.panels = new Set([...this.panels, id]);
    this.panelFocus = id;
    this.emit();
  }

  /** The panel to bring to the front, once (the dock does it). */
  takePanelFocus(): string | null {
    const f = this.panelFocus;
    this.panelFocus = null;
    return f;
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
    this.files = {};
    this.calibration = {};
    if (this.backdrop) URL.revokeObjectURL(this.backdrop.url);
    this.backdrop = null;
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

  /** Produce EPANET's report and output file for the model as it is now (once per revision). */
  async loadFiles(which: 'report' | 'status'): Promise<void> {
    const rev = this.store.rev;
    const cur = this.files[which];
    if (cur && cur.rev === rev && cur.status !== 'error') return;
    const statusLog = which === 'status';
    const doc = this.store.doc;
    const links = Uint32Array.from(doc.linkHandles());
    this.files = { ...this.files, [which]: { rev, statusLog, status: 'running' } };
    this.emit();
    let next: FilesState;
    try {
      const { value } = await this.engine.runFiles({
        model: toModel(doc),
        inpName: this.fileName,
        date: ctime(),
        statusLog,
      });
      next = { rev, statusLog, status: 'done', files: value, links };
    } catch (e) {
      next = { rev, statusLog, status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
    if (this.files[which]?.rev === rev) {
      this.files = { ...this.files, [which]: next };
      this.emit();
    }
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
