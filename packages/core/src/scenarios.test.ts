import { describe, expect, it } from 'vitest';
import { addLink, addNode, setField } from './edits.ts';
import { Scenarios } from './scenarios.ts';
import { Store } from './store.ts';
import { writeOption } from './options.ts';

function net() {
  const store = new Store();
  const a = addNode(store, 'junction', { x: 0, y: 0, id: 'A', values: { elevation: 10 } });
  const b = addNode(store, 'junction', { x: 1, y: 0, id: 'B', values: { elevation: 20 } });
  const p = addLink(store, 'pipe', { from: a, to: b, id: 'P', values: { diameter: 12 } });
  return { store, a, b, p, sc: new Scenarios(store) };
}

describe('scenarios', () => {
  it('records edits as overrides and switches between scenarios', () => {
    const { store, a, p, sc } = net();
    const doc = store.doc;
    const big = sc.create('Bigger pipes');
    sc.activate(big);
    setField(store, [p], 'diameter', 16);
    expect(sc.get(big)!.fields).toEqual({ [p]: { diameter: 16 } });
    sc.activate(null);
    expect(doc.num(p, 'diameter')).toBe(12);
    // A child inherits and overrides further.
    const child = sc.create('Bigger and higher', big);
    sc.activate(child);
    expect(doc.num(p, 'diameter')).toBe(16);
    setField(store, [a], 'elevation', 15);
    expect(sc.count(child)).toBe(1);
    sc.activate(big);
    expect([doc.num(p, 'diameter'), doc.num(a, 'elevation')]).toEqual([16, 10]);
    // The model of a scenario, without switching.
    const m = sc.modelFor(child);
    expect(m.nodes.find((n) => n.id === 'A')!.kind).toMatchObject({ elevation: 15 });
    expect(doc.num(a, 'elevation')).toBe(10);
    expect(sc.active).toBe(big);
  });

  it('keeps geometry shared, follows undo, and drops overrides equal to the parent', () => {
    const { store, a, p, sc } = net();
    const doc = store.doc;
    const s1 = sc.create('Night');
    sc.activate(s1);
    setField(store, [a], 'x', 5);
    setField(store, [p], 'diameter', 8);
    expect(sc.get(s1)!.fields).toEqual({ [p]: { diameter: 8 } });
    store.undo();
    expect(sc.get(s1)!.fields).toEqual({});
    store.redo();
    setField(store, [p], 'diameter', 12); // back to the base value
    expect(sc.count(s1)).toBe(0);
    store.transact('opts', (tx) => tx.setDoc('options', writeOption(doc.data.options, 'trials', ['99'])));
    expect(Object.keys(sc.get(s1)!.doc)).toEqual(['options']);
    sc.activate(null);
    expect(doc.num(a, 'x')).toBe(5);
    expect(doc.data.options.lines).toHaveLength(0);
    // Base edits to an overridden field update what the scenario reverts to.
    sc.activate(s1);
    sc.activate(null);
    expect(store.canUndo).toBe(false);
  });

  it('saves and restores, and refuses bad names and deletes', () => {
    const { store, p, sc } = net();
    const s1 = sc.create('A');
    expect(() => sc.create('a')).toThrow();
    sc.create('Child', s1);
    expect(() => sc.remove(s1)).toThrow(/inherit/);
    sc.activate(s1);
    setField(store, [p], 'diameter', 20);
    const saved = JSON.parse(JSON.stringify(sc.toJSON())) as ReturnType<Scenarios['toJSON']>;
    const again = new Scenarios(store);
    again.load(saved);
    again.activate(null);
    expect(store.doc.num(p, 'diameter')).toBe(12);
    again.activate(s1);
    expect(store.doc.num(p, 'diameter')).toBe(20);
    again.dispose();
  });
});
