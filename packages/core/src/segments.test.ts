import { describe, expect, it } from 'vitest';
import { addLink, addNode } from './edits.ts';
import { cutOff, segments, valvesEveryEnd, valvesNMinusOne } from './segments.ts';
import { Store } from './store.ts';

// R - A - B - C, with a branch B - D.
function net() {
  const store = new Store();
  const r = addNode(store, 'reservoir', { x: 0, y: 0, id: 'R' });
  const a = addNode(store, 'junction', { x: 1, y: 0, id: 'A' });
  const b = addNode(store, 'junction', { x: 2, y: 0, id: 'B' });
  const c = addNode(store, 'junction', { x: 3, y: 0, id: 'C' });
  const d = addNode(store, 'junction', { x: 2, y: 1, id: 'D' });
  for (const [id, from, to] of [
    ['1', r, a],
    ['2', a, b],
    ['3', b, c],
    ['4', b, d],
  ] as const)
    addLink(store, 'pipe', { from, to, id, values: { length: 100 } });
  return store.doc;
}

describe('isolation segments', () => {
  it('splits the network at valves and finds what closing a segment cuts off', () => {
    const doc = net();
    // One valve on pipe 2 next to A: R-1-A | 2-B-3-C-4-D.
    const r = segments(doc, [{ link: '2', node: 'A' }]);
    expect(r.segments).toHaveLength(2);
    const sizes = r.segments.map((s) => [s.nodes.length, s.links.length, s.length]);
    expect(sizes).toEqual([
      [2, 1, 100],
      [3, 3, 300],
    ]);
    // Closing the upstream segment (with the reservoir) cuts off everything downstream.
    const up = r.of.get(doc.findNode('A')!)!;
    expect(
      cutOff(doc, r, up)
        .map((h) => doc.id(h))
        .sort(),
    ).toEqual(['B', 'C', 'D']);
    const down = r.of.get(doc.findNode('C')!)!;
    expect(cutOff(doc, r, down)).toEqual([]);
    expect(r.segments[down]!.valves.map(([l, n]) => `${doc.id(l)}@${doc.id(n)}`)).toEqual(['2@A']);
  });

  it('places valves by rule', () => {
    const doc = net();
    expect(segments(doc, valvesEveryEnd(doc)).segments.filter((s) => s.links.length > 0)).toHaveLength(4);
    const nm1 = valvesNMinusOne(doc);
    expect(nm1.length).toBe(1 + 2); // A: 1 of 2 pipes; B: 2 of 3
  });
});
