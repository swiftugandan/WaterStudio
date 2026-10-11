// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { symbols } from './catalogue.ts';
import { symbolMasters } from './masters.ts';

const ALLOWED = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const PAINTS = new Set(['fg', 'bg', 'state']);

function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(err.textContent);
  return doc;
}

describe('symbol masters', () => {
  it('exist for exactly the catalogue', () => {
    expect(Object.keys(symbolMasters).sort()).toEqual(symbols.map((s) => s.id).sort());
  });

  for (const s of symbols) {
    describe(s.id, () => {
      const doc = parse(symbolMasters[s.id] ?? '');
      const root = doc.documentElement;

      it('sits on the 24-unit grid', () => {
        expect(root.tagName).toBe('svg');
        expect(root.getAttribute('viewBox')).toBe('0 0 24 24');
      });

      it('uses only plain shapes, each with a paint role', () => {
        for (const el of Array.from(root.querySelectorAll('*'))) {
          expect(ALLOWED.has(el.tagName), `<${el.tagName}>`).toBe(true);
          expect(PAINTS.has(el.getAttribute('data-paint') ?? ''), `${el.tagName} paint`).toBe(true);
        }
      });

      it('keeps foreground strokes at the standard weights', () => {
        for (const el of Array.from(root.querySelectorAll('[data-paint="fg"][stroke-width]'))) {
          expect(['1', '1.25', '1.5']).toContain(el.getAttribute('stroke-width'));
        }
      });

      it('stays inside the grid', () => {
        for (const el of Array.from(root.querySelectorAll('path'))) {
          // Absolute coordinates only appear after M, L, H, V and at arc ends; check all numbers
          // are within the canvas as a cheap bound (relative offsets are small).
          const nums = (el.getAttribute('d') ?? '').match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
          for (const v of nums) expect(Math.abs(v)).toBeLessThanOrEqual(24);
        }
        for (const el of Array.from(root.querySelectorAll('circle'))) {
          const [cx, cy, r] = ['cx', 'cy', 'r'].map((a) => Number(el.getAttribute(a)));
          expect(cx! - r!).toBeGreaterThanOrEqual(0);
          expect(cx! + r!).toBeLessThanOrEqual(24);
          expect(cy! - r!).toBeGreaterThanOrEqual(0);
          expect(cy! + r!).toBeLessThanOrEqual(24);
        }
      });

      if (s.kind === 'link') {
        it('leaves room for the link line at both ends', () => {
          // Link symbols are drawn along +x; nothing may reach the link's ends at x=0 or x=24.
          expect(symbolMasters[s.id]).not.toMatch(/M0[ ,]|H24|h24/);
        });
      }
    });
  }

  it('gives the tank a level fill for playback', () => {
    expect(symbolMasters['tank']).toContain('data-role="level"');
  });
});
