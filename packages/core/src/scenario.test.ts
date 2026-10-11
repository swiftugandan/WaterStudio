import { describe, expect, it } from 'vitest';
import { addLink, addNode } from './edits.ts';
import { applyScenario, scenarioText } from './scenario.ts';
import { Store } from './store.ts';

function net() {
  const store = new Store();
  const a = addNode(store, 'junction', { x: 0, y: 0, id: 'J1' });
  const b = addNode(store, 'junction', { x: 1, y: 0, id: 'J2' });
  const r = addNode(store, 'reservoir', { x: 2, y: 0, id: 'R' });
  addLink(store, 'pipe', { from: r, to: a, id: 'P1', values: { diameter: 12, roughness: 100 } });
  addLink(store, 'pipe', { from: a, to: b, id: 'P2', values: { diameter: 8, roughness: 110 } });
  return store;
}

describe('scenarios', () => {
  it('round-trips demands, quality, diameters, roughness and controls', () => {
    const src = net();
    const doc = src.doc;
    src.transact('setup', (tx) => {
      tx.set(doc.findNode('J1')!, 'demands', [
        { base: 5, pattern: null, category: 'homes' },
        { base: 2.5, pattern: 'P', category: null },
      ]);
      tx.set(doc.findNode('R')!, 'initialQuality', 1.2);
      tx.setDoc('controls', [{ tokens: ['LINK', 'P2', 'CLOSED', 'AT', 'TIME', '3'], comment: null }]);
    });
    const text = scenarioText(doc, 'Peak');
    const dst = net();
    const r = applyScenario(dst, text);
    expect(r.issues).toEqual([]);
    expect(r.applied).toEqual({ DEMANDS: 3, QUALITY: 1, DIAMETERS: 2, ROUGHNESS: 2, CONTROLS: 1, RULES: 0 });
    const d = dst.doc;
    expect(d.get(d.findNode('J1')!, 'demands')).toEqual([
      { base: 5, pattern: null, category: 'homes' },
      { base: 2.5, pattern: 'P', category: null },
    ]);
    expect(d.num(d.findNode('R')!, 'initialQuality')).toBe(1.2);
    expect(d.data.controls).toHaveLength(1);
    dst.undo();
    expect(d.data.controls).toHaveLength(0);
  });

  it('skips IDs the network lacks and refuses files that are not scenarios', () => {
    const s = net();
    const r = applyScenario(s, '[DIAMETERS]\nP1 16\nP9 4\nP2 -1\n[PUMPS]\nX 1\n');
    expect(s.doc.num(s.doc.findLink('P1')!, 'diameter')).toBe(16);
    expect(r.issues.join(' ')).toMatch(/\[PUMPS\].*more than 0.*P9/);
    expect(() => applyScenario(s, '[JUNCTIONS]\nJ1 10\n')).toThrow(/none of the sections/);
  });
});
