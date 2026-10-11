import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast } from './contrast.ts';
import { tokensToCss } from './css.ts';
import { colormaps, themes, type ThemeName } from './tokens.ts';

const names: ThemeName[] = ['light', 'dark'];

describe('themes meet WCAG 2.2 AA', () => {
  for (const name of names) {
    const t = themes[name];
    const text: [string, string, string, number][] = [
      ['primary text on surface', t.textPrimary, t.bgSurface, 7],
      ['primary text on app background', t.textPrimary, t.bgApp, 7],
      ['secondary text on surface', t.textSecondary, t.bgSurface, 4.5],
      ['secondary text on header', t.textSecondary, t.bgSurfaceAlt, 4.5],
      ['secondary text on hover', t.textSecondary, t.bgHover, 4.5],
      ['primary text on active', t.textPrimary, t.bgActive, 4.5],
      ['accent text on surface', t.accent, t.bgSurface, 4.5],
      ['text on accent', t.textOnAccent, t.accent, 4.5],
      ['text on accent hover', t.textOnAccent, t.accentHover, 4.5],
      ['success', t.successText, t.successBg, 4.5],
      ['warning', t.warningText, t.warningBg, 4.5],
      ['danger', t.dangerText, t.dangerBg, 4.5],
      ['info', t.infoText, t.infoBg, 4.5],
      ['canvas labels', t.canvasLabel, t.canvasBg, 4.5],
      ['control borders', t.borderControl, t.bgSurface, 3],
      ['focus ring', t.focus, t.bgSurface, 3],
      ['canvas links', t.canvasLink, t.canvasBg, 3],
      ['canvas selection', t.canvasSelection, t.canvasBg, 3],
    ];
    for (const [what, fg, bg, min] of text) {
      it(`${name}: ${what} ≥ ${min}:1`, () => {
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it('both themes define the same roles', () => {
    expect(Object.keys(themes.dark).sort()).toEqual(Object.keys(themes.light).sort());
  });
});

describe('tokens.css', () => {
  it('is up to date (run `pnpm --filter @waterstudio/ui build`)', () => {
    const committed = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
    expect(committed).toBe(tokensToCss());
  });

  it('defines every colour role for both themes', () => {
    const css = tokensToCss();
    expect(css).toContain('--ws-color-bg-surface-alt:');
    expect(css).toContain('[data-theme="dark"]');
    expect(css.match(/--ws-color-canvas-selection:/g)).toHaveLength(3);
  });
});

describe('colormaps', () => {
  it('are valid colours, ordered low to high in lightness for sequential ramps', () => {
    for (const ramp of [colormaps.viridis, colormaps.cividis]) {
      const l = ramp.map((c) => contrast(c, '#000000'));
      for (let i = 1; i < l.length; i++) expect(l[i]).toBeGreaterThan(l[i - 1] ?? 0);
    }
  });
});
