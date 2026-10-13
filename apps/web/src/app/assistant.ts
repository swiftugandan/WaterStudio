/**
 * The assistant's wiring: provider settings remembered per browser (the key only when
 * the user asks), and the agent context over the app state. Conversations stay in
 * this tab.
 */

import {
  AssistantSession,
  DEFAULT_SETTINGS,
  draftContext,
  DESIGN_TOOLS,
  DRAFT_TOOLS,
  providerFor,
  READ_TOOLS,
  systemPrompt,
  ToolRegistry,
  type AgentContext,
  type AgentHost,
  type ProviderSettings,
  type RunView,
  type Scope,
  type SessionEvent,
} from '@waterstudio/agents';
import { EngineSync, toModel, type Store } from '@waterstudio/core';
import type { StudyCallResult } from '@waterstudio/engine-client';
import type { AppState } from './state.ts';
import { ctime } from './time.ts';

const KEY = 'ws.assistant';
const SECRET = 'ws.assistant.key';

/** What the assistant may do: look only, or also propose changes for review. */
export type AssistantMode = 'read' | 'propose';

export interface StoredSettings extends ProviderSettings {
  rememberKey: boolean;
  mode: AssistantMode;
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

export function loadSettings(): StoredSettings {
  let s: Partial<StoredSettings>;
  try {
    s = JSON.parse(storage('local')?.getItem(KEY) ?? '{}') as Partial<StoredSettings>;
  } catch {
    s = {};
  }
  const key = storage('local')?.getItem(SECRET) ?? storage('session')?.getItem(SECRET) ?? undefined;
  return {
    kind: s.kind === 'openai' ? 'openai' : 'anthropic',
    endpoint: s.endpoint || DEFAULT_SETTINGS.endpoint,
    model: s.model || DEFAULT_SETTINGS.model,
    rememberKey: s.rememberKey === true,
    mode: s.mode === 'read' ? 'read' : 'propose',
    ...(key ? { apiKey: key } : {}),
  };
}

export function saveSettings(s: StoredSettings): void {
  const { apiKey, ...rest } = s;
  try {
    storage('local')?.setItem(KEY, JSON.stringify(rest));
    storage('local')?.removeItem(SECRET);
    storage('session')?.removeItem(SECRET);
    if (apiKey) storage(s.rememberKey ? 'local' : 'session')?.setItem(SECRET, apiKey);
  } catch {
    // Without storage the settings last for this page.
  }
}

function view(state: AppState): RunView | null {
  const r = state.run;
  if (r.status !== 'done' || !r.results || !r.nodes || !r.links) return null;
  return { results: r.results, nodes: r.nodes, links: r.links, stale: state.stale };
}

export function agentContext(state: AppState): AgentContext {
  return {
    get doc() {
      return state.store.doc;
    },
    get units() {
      return state.units;
    },
    get fileName() {
      return state.fileName;
    },
    results: () => view(state),
    period: () => state.period,
    analyse: async () => {
      await state.runHydraulics();
      const v = view(state);
      if (!v) throw new Error(state.run.error ?? 'The analysis failed.');
      return v;
    },
    files: async (statusLog) => {
      const { value } = await state.engine.runFiles({
        model: state.sync,
        inpName: state.fileName,
        date: ctime(),
        statusLog,
      });
      return value;
    },
  };
}

const syncs = new WeakMap<Store, EngineSync>();

/** The sync of an agent's draft store, made on its first run. */
function syncOf(store: Store): EngineSync {
  let s = syncs.get(store);
  if (!s) syncs.set(store, (s = new EngineSync(store)));
  return s;
}

/** The app as a host for an agent that drafts and proposes. */
export function agentHost(state: AppState, author: string): AgentHost {
  return {
    get units() {
      return state.units;
    },
    get fileName() {
      return state.fileName;
    },
    author,
    doc: () => state.store.doc,
    period: () => state.period,
    // A draft's engine keeps its model between the agent's runs (ADR 0020).
    run: async (doc, store) => (await state.engine.run(store ? syncOf(store) : toModel(doc))).value,
    files: async (doc, statusLog) =>
      (
        await state.engine.runFiles({
          model: toModel(doc),
          inpName: state.fileName,
          date: ctime(),
          statusLog,
        })
      ).value,
    // The engine answers each kind of study with that kind's result.
    study: async (doc, call, store) =>
      (await state.engine.study({ ...call, model: store ? syncOf(store) : toModel(doc) }))
        .value as StudyCallResult<typeof call>,
    submit: (p) => state.submitProposal(p),
  };
}

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; ok?: boolean; content?: string }
  | { kind: 'error'; text: string };

/** One conversation: the session, what the panel shows, and whether it is busy. */
export class Conversation {
  entries: Entry[] = [];
  busy = false;
  private session: AssistantSession | null = null;
  private settingsKey = '';
  private abort: AbortController | null = null;
  private readonly registry = new ToolRegistry([...READ_TOOLS, ...DRAFT_TOOLS, ...DESIGN_TOOLS]);
  private readonly state: AppState;
  /** The settings of the last message, for sending a proposal back later. */
  private settings: StoredSettings | null = null;

  constructor(state: AppState) {
    this.state = state;
  }

  async send(text: string, settings: StoredSettings): Promise<void> {
    this.settings = settings;
    const key = JSON.stringify([
      settings.kind,
      settings.endpoint,
      settings.model,
      settings.apiKey ?? '',
      settings.mode,
    ]);
    if (!this.session || key !== this.settingsKey) {
      this.settingsKey = key;
      const propose = settings.mode === 'propose';
      const scopes: Scope[] = propose ? ['read', 'analyse', 'draft', 'propose'] : ['read', 'analyse'];
      const ctx = propose
        ? draftContext(agentHost(this.state, `Assistant (${settings.model})`))
        : agentContext(this.state);
      this.session = new AssistantSession(providerFor(settings), this.registry, ctx, {
        system: systemPrompt(propose),
        scopes,
        maxSteps: propose ? 30 : 12,
      });
    }
    this.entries = [...this.entries, { kind: 'user', text }];
    this.busy = true;
    this.abort = new AbortController();
    this.state.emit();
    const onEvent = (e: SessionEvent) => {
      if (e.kind === 'text') this.entries = [...this.entries, { kind: 'assistant', text: e.text }];
      else if (e.kind === 'tool')
        this.entries = [...this.entries, { kind: 'tool', id: e.id, name: e.name, input: e.input }];
      else if (e.kind === 'tool-result') {
        this.entries = this.entries.map((x) =>
          x.kind === 'tool' && x.id === e.id ? { ...x, ok: e.ok, content: e.content } : x,
        );
      } else this.entries = [...this.entries, { kind: 'error', text: e.message }];
      this.state.emit();
    };
    try {
      await this.session.send(text, onEvent, this.abort.signal);
    } finally {
      this.busy = false;
      this.abort = null;
      this.state.emit();
    }
  }

  /** Tell the agent its proposal came back, with the reviewer's comment, if it can still be reached. */
  sendBack(text: string): boolean {
    if (!this.settings || this.busy) return false;
    void this.send(text, this.settings);
    return true;
  }

  stop(): void {
    this.abort?.abort();
  }

  clear(): void {
    this.entries = [];
    this.session = null;
    this.state.emit();
  }
}
