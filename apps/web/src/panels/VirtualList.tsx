import { useRef, useState, type ReactNode } from 'react';

/** A fixed-row-height virtual list: renders only the rows in view. */
export function VirtualList({
  count,
  rowHeight,
  render,
  label,
  className,
}: {
  count: number;
  rowHeight: number;
  render: (i: number) => ReactNode;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const height = ref.current?.clientHeight ?? 600;
  const first = Math.max(0, Math.floor(top / rowHeight) - 5);
  const last = Math.min(count, Math.ceil((top + height) / rowHeight) + 5);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(render(i));
  return (
    <div
      ref={ref}
      className={`vlist ${className ?? ''}`}
      role="list"
      aria-label={label}
      tabIndex={0}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: count * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>{rows}</div>
      </div>
    </div>
  );
}
