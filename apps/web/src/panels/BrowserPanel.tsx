/** The model browser: elements by class, and the network's data objects. */

import { LINK_KINDS, NODE_KINDS, type ElementKind } from '@waterstudio/core';
import { useMemo, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { Icon } from '../shell/Icon.tsx';
import { VirtualList } from './VirtualList.tsx';

const CLASSES: { kind: ElementKind; label: string; icon: string }[] = [
  { kind: 'junction', label: 'Junctions', icon: 'junction' },
  { kind: 'reservoir', label: 'Reservoirs', icon: 'reservoir' },
  { kind: 'tank', label: 'Tanks', icon: 'tank' },
  { kind: 'pipe', label: 'Pipes', icon: 'pipe' },
  { kind: 'pump', label: 'Pumps', icon: 'pump' },
  { kind: 'valve', label: 'Valves', icon: 'valve' },
];

export function BrowserPanel() {
  const { state, version } = useApp();
  const [open, setOpen] = useState<ElementKind>('junction');
  const [filter, setFilter] = useState('');
  const doc = state.store.doc;

  const groups = useMemo(() => {
    const by = new Map<ElementKind, number[]>();
    for (const k of [...NODE_KINDS, ...LINK_KINDS]) by.set(k, []);
    for (const h of doc.nodeHandles()) by.get(doc.nodeKind(h))!.push(h);
    for (const h of doc.linkHandles()) by.get(doc.linkKind(h))!.push(h);
    return by;
    // version: recompute on every change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, version]);

  const items = (groups.get(open) ?? []).filter(
    (h) => filter === '' || doc.id(h).toLowerCase().includes(filter.toLowerCase()),
  );
  const data = doc.data;

  return (
    <div className="panel browser">
      <div className="browser-classes" role="tablist" aria-label="Element classes">
        {CLASSES.map((c) => (
          <button
            key={c.kind}
            type="button"
            role="tab"
            aria-selected={open === c.kind}
            onClick={() => setOpen(c.kind)}
            title={c.label}
          >
            <Icon name={c.icon} size={16} />
            <span>{c.label}</span>
            <span className="count">{groups.get(c.kind)?.length ?? 0}</span>
          </button>
        ))}
      </div>
      <input
        className="filter"
        type="search"
        placeholder="Filter by ID"
        aria-label="Filter elements by ID"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <VirtualList
        label={`${open} list`}
        count={items.length}
        rowHeight={24}
        onActivate={(i, mode) => state.select([items[i]!], mode)}
        isSelected={(i) => state.selection.has(items[i]!)}
        render={(i) => {
          const h = items[i]!;
          return (
            <div
              key={h}
              className={`vrow${state.selection.has(h) ? ' selected' : ''}`}
              onClick={(e) => state.select([h], e.shiftKey || e.ctrlKey || e.metaKey ? 'toggle' : 'replace')}
              onDoubleClick={() => state.view?.zoomTo([h])}
            >
              {doc.id(h)}
            </div>
          );
        }}
      />
      <div className="browser-data" role="group" aria-label="Network data">
        {(
          [
            ['options', 'Options', null],
            ['patterns', 'Patterns', data.patterns.length],
            ['curves', 'Curves', data.curves.length],
            ['controls', 'Controls', data.controls.length],
            ['controls', 'Rules', data.rules.length],
          ] as const
        ).map(([panel, label, n]) => (
          <button key={label} type="button" onClick={() => state.showPanel(panel)}>
            {label}
            {n !== null && <span className="count">{n}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
