/**
 * The AI assistant: a conversation with a language model that can look at the network
 * and its results through tools and run analyses, and (when allowed) edit a draft copy
 * and propose the change for review. Each tool call is shown, so the engineer can see
 * where every number came from. The provider, endpoint and
 * model are settings; an API key stays in this browser and goes only to the endpoint.
 */

import { useEffect, useRef, useState } from 'react';
import { loadSettings, saveSettings, type Entry, type StoredSettings } from '../app/assistant.ts';
import { useApp } from '../app/context.tsx';

function Settings({
  initial,
  onSave,
  onCancel,
}: {
  initial: StoredSettings;
  onSave: (s: StoredSettings) => void;
  onCancel?: () => void;
}) {
  const [s, setS] = useState(initial);
  return (
    <form
      className="assistant-settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(s);
      }}
    >
      <p className="muted">
        The assistant sends your questions and what its tools return (element IDs, attributes and results) to
        the provider below. Use your organisation&rsquo;s proxy if it has one.
      </p>
      <label>
        <span>Provider</span>
        <select
          value={s.kind}
          onChange={(e) => {
            const kind = e.target.value as StoredSettings['kind'];
            setS({
              ...s,
              kind,
              endpoint:
                kind === 'anthropic'
                  ? 'https://api.anthropic.com/v1/messages'
                  : 'http://localhost:11434/v1/chat/completions',
            });
          }}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI-compatible (local or proxy)</option>
        </select>
      </label>
      <label>
        <span>Endpoint</span>
        <input
          type="url"
          required
          value={s.endpoint}
          onChange={(e) => setS({ ...s, endpoint: e.target.value })}
        />
      </label>
      <label>
        <span>Model</span>
        <input type="text" required value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} />
      </label>
      <label>
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          value={s.apiKey ?? ''}
          placeholder="Not needed behind a proxy"
          onChange={(e) => {
            const rest = { ...s };
            delete rest.apiKey;
            setS(e.target.value ? { ...rest, apiKey: e.target.value } : rest);
          }}
        />
      </label>
      <label>
        <span>The assistant may</span>
        <select
          value={s.mode}
          onChange={(e) => setS({ ...s, mode: e.target.value as StoredSettings['mode'] })}
        >
          <option value="propose">Look, run analyses and propose changes for review</option>
          <option value="read">Only look and run analyses</option>
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={s.rememberKey}
          onChange={(e) => setS({ ...s, rememberKey: e.target.checked })}
        />
        <span>Remember the key in this browser (otherwise only for this tab)</span>
      </label>
      <div className="row">
        <button type="submit" className="btn primary">
          Save
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ToolCall({ e }: { e: Extract<Entry, { kind: 'tool' }> }) {
  const args = JSON.stringify(e.input);
  return (
    <details className={`assistant-tool${e.ok === false ? ' failed' : ''}`}>
      <summary>
        {e.ok === undefined ? 'Running' : e.ok ? 'Used' : 'Failed'} <code>{e.name}</code>
        {args !== '{}' && <span className="muted"> {args.length > 80 ? `${args.slice(0, 80)}…` : args}</span>}
      </summary>
      {e.content !== undefined && (
        <pre>{e.content.length > 4000 ? `${e.content.slice(0, 4000)}…` : e.content}</pre>
      )}
    </details>
  );
}

const SUGGESTIONS = [
  'Summarise this network.',
  'Run the analysis and tell me where pressures are lowest.',
  'Which pipes have velocities above 2 m/s (or 6 ft/s)?',
  'Explain the warnings in the status report.',
];
const PROPOSE_SUGGESTIONS = ['Propose larger pipes where junction pressures are lowest.'];

export function AssistantPanel() {
  const { state } = useApp();
  const convo = state.conversation;
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings());
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const configured = settings.endpoint !== '' && settings.model !== '';

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [convo.entries.length]);

  const send = (q: string) => {
    const t = q.trim();
    if (!t || convo.busy) return;
    setText('');
    void convo.send(t, settings);
  };

  if (editing || !configured) {
    return (
      <div className="panel assistant">
        <Settings
          initial={settings}
          onSave={(s) => {
            saveSettings(s);
            setSettings(s);
            setEditing(false);
          }}
          {...(configured ? { onCancel: () => setEditing(false) } : {})}
        />
      </div>
    );
  }

  return (
    <div className="panel assistant">
      <div className="panel-toolbar">
        <span className="muted">
          {settings.model} · {settings.mode === 'propose' ? 'may propose changes' : 'read only'}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={() => convo.clear()}
          disabled={convo.busy || convo.entries.length === 0}
        >
          New conversation
        </button>
        <button type="button" className="btn" onClick={() => setEditing(true)}>
          Settings
        </button>
      </div>
      <div className="assistant-log" ref={log} role="log" aria-label="Conversation" aria-live="polite">
        {convo.entries.length === 0 && (
          <div className="assistant-empty">
            <p>
              {settings.mode === 'propose'
                ? 'Ask about the network, or ask for a change. The assistant looks things up with tools and runs the analysis; changes it makes go to a draft copy and come back as a proposal you review in Proposals.'
                : 'Ask about the network and its results. The assistant looks things up with tools and can run the analysis, but does not edit the network.'}
            </p>
            <ul>
              {[...SUGGESTIONS, ...(settings.mode === 'propose' ? PROPOSE_SUGGESTIONS : [])].map((s) => (
                <li key={s}>
                  <button type="button" className="link" onClick={() => send(s)}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {convo.entries.map((e, i) =>
          e.kind === 'tool' ? (
            <ToolCall key={i} e={e} />
          ) : (
            <div
              key={i}
              className={`assistant-msg ${e.kind}`}
              {...(e.kind === 'error' ? { role: 'alert' } : {})}
            >
              {e.text}
            </div>
          ),
        )}
        {convo.busy && <div className="assistant-msg thinking">Working…</div>}
      </div>
      <form
        className="assistant-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <textarea
          aria-label="Message to the assistant"
          value={text}
          rows={2}
          placeholder="Ask about the network…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
        />
        {convo.busy ? (
          <button type="button" className="btn" onClick={() => convo.stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!text.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
