// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hydraulicIconNames, hydraulicIconSvg, hydraulicIcons } from './hydraulic.ts';

describe('hydraulic icons', () => {
  it('have unique markup', () => {
    const seen = new Set(Object.values(hydraulicIcons));
    expect(seen.size).toBe(hydraulicIconNames.length);
  });

  for (const name of hydraulicIconNames) {
    it(`${name} is well-formed on the 24 px grid`, () => {
      const doc = new DOMParser().parseFromString(hydraulicIconSvg(name), 'image/svg+xml');
      expect(doc.querySelector('parsererror')).toBeNull();
      for (const el of Array.from(doc.documentElement.querySelectorAll('*'))) {
        expect(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']).toContain(el.tagName);
        const fill = el.getAttribute('fill');
        expect(fill === null || fill === 'currentColor' || fill === 'none').toBe(true);
        expect(el.getAttribute('stroke')).toBeNull(); // colour always comes from the root's currentColor
      }
      const nums = hydraulicIcons[name].match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
      for (const v of nums) expect(Math.abs(v)).toBeLessThanOrEqual(24);
    });
  }
});
