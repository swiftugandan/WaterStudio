import { HydraulicIcon, colormaps, fontSize, space, themes } from '@waterstudio/ui';

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export function TokenGallery() {
  return (
    <section className="card" aria-labelledby="tokens-h">
      <h2 id="tokens-h">
        <HydraulicIcon name="map-theme" size={20} /> Design tokens
      </h2>
      <p className="muted">
        Semantic colour roles for the current theme, checked against WCAG 2.2 AA in the test suite, then type,
        spacing and the colour-blind-safe result ramps.
      </p>
      <h3>Colour roles</h3>
      <ul className="swatches" aria-label="Colour roles">
        {Object.keys(themes.light).map((role) => (
          <li key={role}>
            <span className="swatch" style={{ background: `var(--ws-color-${kebab(role)})` }} />
            <code>{kebab(role)}</code>
          </li>
        ))}
      </ul>
      <h3>Type</h3>
      <ul className="type-scale" aria-label="Type scale">
        {Object.entries(fontSize).map(([k, v]) => (
          <li key={k} style={{ fontSize: v }}>
            <code>{k}</code> {v}px Pipe 1043 · 72.4 psi
          </li>
        ))}
      </ul>
      <h3>Spacing (4 px grid)</h3>
      <ul className="spacing" aria-label="Spacing scale">
        {Object.entries(space)
          .filter(([, v]) => v > 0)
          .sort(([, a], [, b]) => a - b)
          .map(([k, v]) => (
            <li key={k}>
              <span className="bar" style={{ width: v }} />
              <code>
                {k} · {v}px
              </code>
            </li>
          ))}
      </ul>
      <h3>Result ramps</h3>
      <ul className="ramps" aria-label="Colour ramps">
        {Object.keys(colormaps).map((k) => (
          <li key={k}>
            <span className="ramp" style={{ background: `var(--ws-ramp-${k})` }} />
            <code>{k}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
