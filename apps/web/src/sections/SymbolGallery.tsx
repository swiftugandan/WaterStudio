import { symbolSvg, symbols } from '@waterstudio/symbols';
import { HydraulicIcon } from '@waterstudio/ui';

export function SymbolGallery() {
  return (
    <section className="card" aria-labelledby="symbols-h">
      <h2 id="symbols-h">
        <HydraulicIcon name="valve" size={20} /> Engineering symbols
      </h2>
      <p className="muted">
        One SVG master per symbol on a 24-unit grid, compiled later into the renderer's symbol atlas and into
        SVG and DXF exports. Shown here on the map canvas colours, with the link line passing through.
      </p>
      <ul className="symbol-grid" aria-label="Engineering symbols">
        {symbols.map((s) => (
          <li key={s.id} title={s.description}>
            <div
              className={`symbol ${s.kind}`}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: symbolSvg(s.id) }}
            />
            <span>{s.name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
