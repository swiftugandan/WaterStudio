/**
 * Simple controls and rule-based controls, edited as text in EPANET's own syntax.
 * Apply checks the edited model with the engine's input stage, so a control EPANET
 * would refuse is reported with EPANET's message before it reaches the model; a valid
 * change is one undoable edit.
 */

import { controlsText, EditError, parseControls, parseRules, rulesText, toModel } from '@waterstudio/core';
import { useState } from 'react';
import { useApp } from '../app/context.tsx';
import type { AppState } from '../app/state.ts';

type Tab = 'controls' | 'rules';

const HELP: Record<Tab, string[]> = {
  controls: [
    'LINK linkID status IF NODE nodeID ABOVE|BELOW value',
    'LINK linkID status AT TIME time',
    'LINK linkID status AT CLOCKTIME time AM|PM',
    'status is OPEN, CLOSED, a pump speed or a valve setting. Text after ; is a comment.',
  ],
  rules: [
    'RULE ruleID',
    'IF   condition',
    'AND  condition    (or OR condition)',
    'THEN action',
    'AND  action',
    'ELSE action',
    'PRIORITY value',
    'condition: object ID attribute relation value, e.g. TANK 1 LEVEL ABOVE 19, SYSTEM CLOCKTIME >= 6 AM',
    'action: object ID STATUS|SETTING IS value, e.g. PUMP 9 STATUS IS CLOSED',
  ],
};

function current(state: AppState, tab: Tab): string {
  const d = state.store.doc.data;
  return tab === 'controls' ? controlsText(d.controls) : rulesText(d.rules);
}

export function ControlsPanel() {
  const { state } = useApp();
  const [tab, setTab] = useState<Tab>('controls');
  const [drafts, setDrafts] = useState<Record<Tab, string | null>>({ controls: null, rules: null });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = current(state, tab);
  const text = drafts[tab] ?? saved;
  const dirty = drafts[tab] !== null && drafts[tab] !== saved;

  const apply = async () => {
    let controls = state.store.doc.data.controls;
    let rules = state.store.doc.data.rules;
    try {
      if (tab === 'controls') controls = parseControls(text);
      else rules = parseRules(text);
    } catch (e) {
      if (e instanceof EditError) {
        setMessage({ ok: false, text: e.message });
        return;
      }
      throw e;
    }
    setBusy(true);
    try {
      const { value: error } = await state.engine.check({ ...toModel(state.store.doc), controls, rules });
      if (error) {
        setMessage({ ok: false, text: error });
        return;
      }
      state.store.transact(tab === 'controls' ? 'Edit controls' : 'Edit rules', (tx) =>
        tab === 'controls' ? tx.setDoc('controls', controls) : tx.setDoc('rules', rules),
      );
      setDrafts({ ...drafts, [tab]: null });
      const n = tab === 'controls' ? controls.length : rules.length;
      setMessage({
        ok: true,
        text: `${n} ${tab === 'controls' ? 'control' : 'rule'}${n === 1 ? '' : 's'} applied.`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel controls-editor">
      <div className="panel-toolbar">
        <div className="segmented" role="tablist" aria-label="Control type">
          {(
            [
              ['controls', 'Simple controls'],
              ['rules', 'Rules'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'on' : undefined}
              onClick={() => {
                setTab(id);
                setMessage(null);
              }}
            >
              {label}
              {drafts[id] !== null && drafts[id] !== current(state, id) ? ' •' : ''}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy}
          onClick={() => {
            setDrafts({ ...drafts, [tab]: null });
            setMessage(null);
          }}
        >
          Revert
        </button>
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={() => void apply()}>
          Apply
        </button>
      </div>
      <textarea
        className="code-editor"
        aria-label={tab === 'controls' ? 'Simple controls, one per line' : 'Rule-based controls'}
        spellCheck={false}
        value={text}
        placeholder={
          tab === 'controls'
            ? 'LINK 9 CLOSED IF NODE 2 ABOVE 140'
            : 'RULE 1\nIF TANK 1 LEVEL ABOVE 19\nTHEN PUMP 9 STATUS IS CLOSED'
        }
        onChange={(e) => setDrafts({ ...drafts, [tab]: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && dirty) {
            e.preventDefault();
            void apply();
          }
        }}
      />
      {message && (
        <p className={message.ok ? 'muted' : 'field-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
      <details className="syntax-help">
        <summary>Syntax</summary>
        <pre>{HELP[tab].join('\n')}</pre>
      </details>
    </div>
  );
}
