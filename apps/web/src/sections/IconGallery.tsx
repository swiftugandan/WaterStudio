import { HydraulicIcon, hydraulicIconNames } from '@waterstudio/ui';
import {
  ClipboardPaste,
  Copy,
  Download,
  FolderOpen,
  Layers,
  Map,
  MousePointer2,
  Redo2,
  Ruler,
  Save,
  Search,
  Settings,
  Undo2,
  Upload,
  ZoomIn,
} from 'lucide-react';

const GENERIC = [
  ['open', FolderOpen],
  ['save', Save],
  ['undo', Undo2],
  ['redo', Redo2],
  ['copy', Copy],
  ['paste', ClipboardPaste],
  ['select', MousePointer2],
  ['find', Search],
  ['zoom', ZoomIn],
  ['layers', Layers],
  ['basemap', Map],
  ['measure', Ruler],
  ['import', Upload],
  ['export', Download],
  ['settings', Settings],
] as const;

export function IconGallery() {
  return (
    <section className="card" aria-labelledby="icons-h">
      <h2 id="icons-h">
        <HydraulicIcon name="network" size={20} /> Interface icons
      </h2>
      <p className="muted">
        Hydraulic actions drawn on Lucide's 24-pixel grid and stroke, beside Lucide's generic icons (ISC
        licence).
      </p>
      <ul className="icon-grid" aria-label="Hydraulic icons">
        {hydraulicIconNames.map((n) => (
          <li key={n}>
            <HydraulicIcon name={n} size={24} />
            <span>{n}</span>
          </li>
        ))}
      </ul>
      <h3>Generic (Lucide)</h3>
      <ul className="icon-grid" aria-label="Generic icons">
        {GENERIC.map(([n, I]) => (
          <li key={n}>
            <I size={24} aria-hidden="true" />
            <span>{n}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
