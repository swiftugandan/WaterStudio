/** Command palette: type to find any command and run it. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { shortcutLabel } from '../app/shortcuts.ts';
import { Icon } from './Icon.tsx';

function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i;
  // Subsequence match.
  let k = 0;
  for (const ch of t) if (ch === q[k]) k++;
  return k === q.length ? 10 : 0;
}

export function CommandPalette() {
  const { state, bus } = useApp();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const open = state.paletteOpen;
  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);
  const items = useMemo(
    () =>
      bus
        .all()
        .map((c) => ({ c, s: score(q.toLowerCase().trim(), `${c.category} ${c.title}`) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((x) => x.c),
    [bus, q],
  );
  if (!open) return null;
  const close = () => {
    state.paletteOpen = false;
    state.emit();
  };
  const run = (id: string) => {
    close();
    if (bus.isEnabled(id)) bus.execute(id);
  };
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? `pal-${items[active].id}` : undefined}
          placeholder="Type a command"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') setActive((a) => Math.min(items.length - 1, a + 1));
            if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
            if (e.key === 'Enter' && items[active]) run(items[active].id);
          }}
        />
        <ul id="palette-list" role="listbox" aria-label="Commands">
          {items.map((c, i) => (
            <li
              key={c.id}
              id={`pal-${c.id}`}
              role="option"
              aria-selected={i === active}
              aria-disabled={!bus.isEnabled(c.id)}
              className={i === active ? 'active' : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c.id)}
            >
              <Icon name={c.icon} size={16} />
              <span className="cat">{c.category}</span>
              <span className="title">{c.title}</span>
              {c.shortcut && <kbd>{shortcutLabel(c.shortcut)}</kbd>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
