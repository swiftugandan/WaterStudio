import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * A fixed-row-height virtual list: renders only the rows in view. With `onActivate`
 * it is a listbox: arrow keys, Home, End and Page Up/Down move the active row, and
 * Enter or Space activates it (Ctrl or Cmd to toggle, Shift to add), so elements can
 * be chosen without a pointer.
 */
export function VirtualList({
  count,
  rowHeight,
  render,
  label,
  className,
  onActivate,
  isSelected,
}: {
  count: number;
  rowHeight: number;
  render: (i: number) => ReactNode;
  label: string;
  className?: string;
  onActivate?: (i: number, mode: 'replace' | 'toggle' | 'add') => void;
  isSelected?: (i: number) => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [active, setActive] = useState(-1);
  const id = useId();
  const height = ref.current?.clientHeight ?? 600;
  const first = Math.max(0, Math.floor(top / rowHeight) - 5);
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + 5);
  const current = active >= count ? count - 1 : active;
  const listbox = onActivate !== undefined;

  const moveTo = (i: number) => {
    const next = Math.max(0, Math.min(count - 1, i));
    setActive(next);
    const el = ref.current;
    if (!el) return;
    const y = next * rowHeight;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + rowHeight - el.clientHeight;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!listbox || count === 0) return;
    const page = Math.max(1, Math.floor(height / rowHeight) - 1);
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(current + 1),
      ArrowUp: () => moveTo(current < 0 ? 0 : current - 1),
      Home: () => moveTo(0),
      End: () => moveTo(count - 1),
      PageDown: () => moveTo(current + page),
      PageUp: () => moveTo(current - page),
      Enter: () =>
        current >= 0 &&
        onActivate(current, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace'),
      ' ': () =>
        current >= 0 &&
        onActivate(current, e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'replace'),
    };
    const k = keys[e.key];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    k();
  };

  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div
        key={i}
        id={`${id}-${i}`}
        role={listbox ? 'option' : 'listitem'}
        aria-selected={listbox ? (isSelected?.(i) ?? false) : undefined}
        className={i === current ? 'vactive' : undefined}
      >
        {render(i)}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      className={`vlist ${className ?? ''}`}
      role={listbox ? 'listbox' : 'list'}
      aria-label={label}
      aria-multiselectable={listbox ? true : undefined}
      aria-activedescendant={listbox && current >= 0 ? `${id}-${current}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (listbox && current < 0 && count > 0) setActive(Math.min(count - 1, Math.floor(top / rowHeight)));
      }}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: count * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>{rows}</div>
      </div>
    </div>
  );
}
