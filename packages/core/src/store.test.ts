import { describe, expect, it } from 'vitest';
import {
  addLink,
  addNode,
  copyProperties,
  deleteElements,
  EditError,
  groupEdit,
  moveNodes,
  nextId,
  pasteProperties,
  reverseLinks,
  setField,
  setVertices,
} from './edits.ts';
import { Store, type Change } from './store.ts';

function net() {
  const store = new Store();
  const a = addNode(store, 'reservoir', { x: 0, y: 0, id: 'R', values: { head: 100 } });
  const b = addNode(store, 'junction', { x: 10, y: 0, id: 'J1', values: { elevation: 5 } });
  const c = addNode(store, 'junction', { x: 20, y: 0, id: 'J2' });
  const p1 = addLink(store, 'pipe', { from: a, to: b, id: 'P1' });
  const p2 = addLink(store, 'pipe', { from: b, to: c, id: 'P2', vertices: [15, 5] });
  return { store, a, b, c, p1, p2 };
}

describe('store', () => {
  it('builds a network with stable handles and IDs', () => {
    const { store, b, p2 } = net();
    expect(store.doc.findNode('J1')).toBe(b);
    expect(store.doc.findLink('P2')).toBe(p2);
    expect(store.doc.nodeKind(b)).toBe('junction');
    expect(store.doc.linkKind(p2)).toBe('pipe');
    expect(store.doc.num(b, 'elevation')).toBe(5);
    expect(store.doc.num(p2, 'diameter')).toBe(12); // catalogue default
    expect(store.doc.get(b, 'demands')).toEqual([{ base: 0, pattern: null, category: null }]);
  });

  it('undoes and redoes exactly', () => {
    const { store, b } = net();
    setField(store, [b], 'elevation', 42);
    expect(store.doc.num(b, 'elevation')).toBe(42);
    store.undo();
    expect(store.doc.num(b, 'elevation')).toBe(5);
    store.redo();
    expect(store.doc.num(b, 'elevation')).toBe(42);
  });

  it('deletes a node with its links, and undo restores the same rows and order', () => {
    const { store, a, b, c, p1, p2 } = net();
    const order = () => [...store.doc.nodeHandles()];
    expect(deleteElements(store, [b])).toBe(3);
    expect(store.doc.has(b) || store.doc.has(p1) || store.doc.has(p2)).toBe(false);
    expect(order()).toEqual([a, c]);
    expect(store.doc.findNode('J1')).toBeUndefined();
    store.undo();
    expect(order()).toEqual([a, b, c]);
    expect([...store.doc.linkHandles()]).toEqual([p1, p2]);
    expect(store.doc.findLink('P1')).toBe(p1);
    expect(store.doc.get(p2, 'vertices')).toEqual([15, 5]);
    store.redo();
    expect(order()).toEqual([a, c]);
  });

  it('undoing an add removes it; redo brings back the same handle', () => {
    const store = new Store();
    const h = addNode(store, 'junction', { x: 1, y: 2 });
    store.undo();
    expect(store.doc.has(h)).toBe(false);
    store.redo();
    expect(store.doc.has(h)).toBe(true);
    expect(store.doc.num(h, 'x')).toBe(1);
  });

  it('coalesces a drag into one undo step', () => {
    const { store, b, p2 } = net();
    let t = 0;
    store.now = () => t;
    for (let i = 0; i < 10; i++) {
      t += 16;
      moveNodes(store, [b], 1, 0, 'drag-1');
    }
    expect(store.doc.num(b, 'x')).toBe(20);
    store.undo();
    expect(store.doc.num(b, 'x')).toBe(10);
    expect(store.doc.get(p2, 'vertices')).toEqual([15, 5]);
  });

  it('moves the vertices of links whose both ends move', () => {
    const { store, b, c, p2 } = net();
    moveNodes(store, [b, c], 2, 3);
    expect(store.doc.get(p2, 'vertices')).toEqual([17, 8]);
  });

  it('rolls back a transaction that throws', () => {
    const { store, b } = net();
    const rev = store.rev;
    expect(() =>
      store.transact('bad', (tx) => {
        tx.set(b, 'elevation', 99);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.doc.num(b, 'elevation')).toBe(5);
    expect(store.rev).toBe(rev);
  });

  it('validates edits', () => {
    const { store, a, b } = net();
    expect(() => setField(store, [b], 'id', 'R')).toThrow(EditError);
    expect(() => setField(store, [b], 'id', 'has space')).toThrow(EditError);
    expect(() => setField(store, [b], 'diameter', 3)).toThrow(/no field/);
    expect(() => addLink(store, 'pipe', { from: a, to: a })).toThrow(EditError);
    expect(() => addNode(store, 'junction', { x: 0, y: 0, id: 'J1' })).toThrow(/already exists/);
    setField(store, [b], 'id', 'Node-B');
    expect(store.doc.findNode('Node-B')).toBe(b);
    expect(store.doc.findNode('J1')).toBeUndefined();
    store.undo();
    expect(store.doc.findNode('J1')).toBe(b);
  });

  it('tells listeners what changed', () => {
    const { store, b } = net();
    const seen: Change[] = [];
    store.subscribe((c) => seen.push(c));
    setField(store, [b], 'elevation', 1);
    deleteElements(store, [b]);
    store.undo();
    expect(seen.map((c) => [c.source, c.structural])).toEqual([
      ['edit', false],
      ['edit', true],
      ['undo', true],
    ]);
    expect(seen[0]!.fields).toEqual(new Set(['elevation']));
    expect(seen[0]!.elements).toEqual(new Set([b]));
  });

  it('picks the next free ID', () => {
    const { store } = net();
    expect(nextId(store.doc, 'node')).toBe('4');
    addNode(store, 'junction', { x: 0, y: 0, id: '4' });
    expect(nextId(store.doc, 'node')).toBe('5');
    expect(nextId(store.doc, 'link', 'P')).toBe('P3');
  });

  it('handles many elements', () => {
    const store = new Store();
    store.transact('bulk', (tx) => {
      for (let i = 0; i < 5000; i++) tx.addNode('junction', { id: `N${i}`, x: i, y: 0, demands: [] });
    });
    expect(store.doc.nodes.liveCount).toBe(5000);
    expect(store.doc.findNode('N4999')).toBeDefined();
    store.undo();
    expect(store.doc.nodes.liveCount).toBe(0);
  });
});

describe('group edit', () => {
  it('replaces, multiplies and adds in one undo step, skipping kinds without the field', () => {
    const store = new Store();
    const a = addNode(store, 'junction', { x: 0, y: 0, values: { elevation: 10 } });
    const b = addNode(store, 'junction', { x: 1, y: 0, values: { elevation: 20 } });
    const r = addNode(store, 'reservoir', { x: 2, y: 0 });
    const p = addLink(store, 'pipe', { from: a, to: b, values: { diameter: 100 } });
    expect(groupEdit(store, [a, b, r, p], 'elevation', 'add', 5)).toBe(2);
    expect([store.doc.num(a, 'elevation'), store.doc.num(b, 'elevation')]).toEqual([15, 25]);
    groupEdit(store, [p], 'diameter', 'multiply', 1.5);
    expect(store.doc.num(p, 'diameter')).toBe(150);
    store.undo();
    store.undo();
    expect(store.doc.num(a, 'elevation')).toBe(10);
    expect(() => groupEdit(store, [p], 'diameter', 'add', -500)).toThrow(EditError);
    expect(store.doc.num(p, 'diameter')).toBe(100);
  });
});

describe('link geometry', () => {
  it('reverses links and keeps auto-lengths in the same step as the edit', () => {
    const store = new Store();
    const a = addNode(store, 'junction', { x: 0, y: 0 });
    const b = addNode(store, 'junction', { x: 30, y: 40 });
    const p = addLink(store, 'pipe', { from: a, to: b, vertices: [10, 0, 20, 10] });
    expect(reverseLinks(store, [p, a])).toBe(1);
    expect([store.doc.num(p, 'from'), store.doc.num(p, 'to')]).toEqual([b, a]);
    expect(store.doc.get(p, 'vertices')).toEqual([20, 10, 10, 0]);
    store.undo();
    expect(store.doc.num(p, 'from')).toBe(a);
    const straight = () => 50;
    setVertices(store, p, [], straight);
    expect(store.doc.num(p, 'length')).toBe(50);
    moveNodes(store, [b], 10, 0, undefined, () => 123.456);
    expect(store.doc.num(p, 'length')).toBe(123.46);
    store.undo();
    expect([store.doc.num(b, 'x'), store.doc.num(p, 'length')]).toEqual([30, 50]);
    expect(() => setVertices(store, p, [1])).toThrow(EditError);
  });
});

describe('copy and paste properties', () => {
  it('pastes everything but identity and place onto elements of the same kind', () => {
    const store = new Store();
    const a = addNode(store, 'junction', { x: 0, y: 0, id: 'A', values: { elevation: 12 } });
    const b = addNode(store, 'junction', { x: 5, y: 5, id: 'B' });
    const t = addNode(store, 'tank', { x: 9, y: 9, id: 'T' });
    store.transact('demand', (tx) => tx.set(a, 'demands', [{ base: 4, pattern: null, category: 'x' }]));
    const clip = copyProperties(store.doc, a);
    expect(pasteProperties(store, [b, t], clip)).toBe(1);
    expect(store.doc.num(b, 'elevation')).toBe(12);
    expect(store.doc.get(b, 'demands')).toEqual([{ base: 4, pattern: null, category: 'x' }]);
    expect([store.doc.id(b), store.doc.num(b, 'x')]).toEqual(['B', 5]);
    store.undo();
    expect(store.doc.num(b, 'elevation')).toBe(0);
  });
});
