/**
 * The assistant's wiring: provider settings remembered per browser (the key only when
 * the user asks), and the agent context over the app state. Conversations stay in
 * this tab.
 */

import {
  AssistantSession,
  DEFAULT_SETTINGS,
  providerFor,
  READ_TOOLS,
  ToolRegistry,
  type AgentContext,
  type ProviderSettings,
  type RunView,
  type SessionEvent,
} from '@waterstudio/agents';
import { toModel } from '@waterstudio/core';
import type { AppState } from './state.ts';
import { ctime } from './time.ts';

const KEY = 'ws.assistant';
const SECRET = 'ws.assistant.key';

export interface StoredSettings extends ProviderSettings {
  rememberKey: boolean;
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
        model: toModel(state.store.doc),
        inpName: state.fileName,
        date: ctime(),
        statusLog,
      });
      return value;
    },
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
  private readonly registry = new ToolRegistry(READ_TOOLS);
  private readonly state: AppState;

  constructor(state: AppState) {
    this.state = state;
  }

  async send(text: string, settings: ProviderSettings): Promise<void> {
    const key = JSON.stringify([settings.kind, settings.endpoint, settings.model, settings.apiKey ?? '']);
    if (!this.session || key !== this.settingsKey) {
      this.settingsKey = key;
      this.session = new AssistantSession(providerFor(settings), this.registry, agentContext(this.state));
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

  stop(): void {
    this.abort?.abort();
  }

  clear(): void {
    this.entries = [];
    this.session = null;
    this.state.emit();
  }
}
