import { describe, expect, it } from 'vitest';
import {
  addCurve,
  addPattern,
  controlsText,
  parseControls,
  parseRules,
  rulesText,
  curveProblem,
  curveUses,
  deleteCurve,
  deletePattern,
  patternUses,
  renameCurve,
  renamePattern,
  updatePattern,
} from './data.ts';
import { addLink, addNode, EditError } from './edits.ts';
import { readOption, writeOption } from './options.ts';
import { Store } from './store.ts';

function net() {
  const store = new Store();
  const a = addNode(store, 'junction', { x: 0, y: 0, id: 'J1' });
  const r = addNode(store, 'reservoir', { x: 1, y: 0, id: 'R1' });
  const p = addLink(store, 'pump', { from: r, to: a, id: 'P1' });
  return { store, a, r, p };
}

describe('patterns and curves', () => {
  it('adds, renames everywhere, and refuses to delete what is used', () => {
    const { store, a, r, p } = net();
    expect(addPattern(store, { multipliers: [1, 2] })).toBe('1');
    expect(addPattern(store, { id: 'DAY' })).toBe('DAY');
    expect(() => addPattern(store, { id: 'day' })).toThrow(EditError);
    store.transact('use', (tx) => {
      tx.set(a, 'demands', [{ base: 1, pattern: '1', category: null }]);
      tx.set(r, 'headPattern', '1');
      tx.set(p, 'pattern', '1');
      tx.setDoc('options', writeOption(store.doc.data.options, 'defaultPattern', ['1']));
    });
    expect(patternUses(store.doc, '1')).toHaveLength(4);
    expect(() => deletePattern(store, '1')).toThrow(/used by/);
    renamePattern(store, '1', 'BASE');
    const doc = store.doc;
    expect(doc.data.patterns.map((x) => x.id)).toEqual(['BASE', 'DAY']);
    expect(doc.get(a, 'demands')).toEqual([{ base: 1, pattern: 'BASE', category: null }]);
    expect(doc.get(r, 'headPattern')).toBe('BASE');
    expect(doc.get(p, 'pattern')).toBe('BASE');
    expect(readOption(doc.data.options, 'defaultPattern')).toEqual(['BASE']);
    // One undo reverts the whole rename.
    store.undo();
    expect(doc.get(r, 'headPattern')).toBe('1');
    expect(doc.data.patterns[0]!.id).toBe('1');
    deletePattern(store, 'DAY');
    expect(doc.data.patterns).toHaveLength(1);
    expect(() => updatePattern(store, '1', { multipliers: [] })).toThrow(EditError);
    updatePattern(store, '1', { multipliers: [0.5, 1.5] });
    expect(doc.data.patterns[0]!.multipliers).toEqual([0.5, 1.5]);
  });

  it('renames curve references and checks curves as EPANET does', () => {
    const { store, p } = net();
    addCurve(store, { id: 'C1', kind: 'pump', points: [[100, 50]] });
    store.transact('use', (tx) => tx.set(p, 'pumpCurve', 'C1'));
    expect(curveUses(store.doc, 'C1')).toEqual(['pump P1 pump curve']);
    renameCurve(store, 'C1', 'PUMP');
    expect(store.doc.get(p, 'pumpCurve')).toBe('PUMP');
    expect(() => deleteCurve(store, 'PUMP')).toThrow(EditError);
    expect(
      curveProblem({
        kind: 'pump',
        points: [
          [0, 60],
          [100, 50],
          [200, 30],
        ],
      }),
    ).toBeUndefined();
    expect(
      curveProblem({
        kind: 'pump',
        points: [
          [0, 60],
          [100, 70],
        ],
      }),
    ).toMatch(/fall/);
    expect(
      curveProblem({
        kind: 'volume',
        points: [
          [1, 1],
          [1, 2],
        ],
      }),
    ).toMatch(/increase/);
    expect(curveProblem({ kind: null, points: [] })).toMatch(/at least one/);
  });

  it('turns controls and rules into text and back', () => {
    const controls = parseControls(
      'LINK 12 CLOSED IF NODE 2 ABOVE 140 ;close at night\n\n; note\nLINK 9 OPEN AT TIME 2',
    );
    expect(controls).toEqual([
      { tokens: ['LINK', '12', 'CLOSED', 'IF', 'NODE', '2', 'ABOVE', '140'], comment: 'close at night' },
      { tokens: ['LINK', '9', 'OPEN', 'AT', 'TIME', '2'], comment: null },
    ]);
    expect(parseControls(controlsText(controls))).toEqual(controls);
    const text =
      'RULE 1\nIF TANK 1 LEVEL > 19\nTHEN PUMP 9 STATUS IS CLOSED\n; comment\n\nRule 2\nIF SYSTEM CLOCKTIME >= 6 AM\nTHEN PUMP 9 STATUS IS OPEN\nPRIORITY 1';
    const rules = parseRules(text);
    expect(rules.map((r) => [r.name, r.lines.length])).toEqual([
      ['1', 4],
      ['2', 4],
    ]);
    expect(rulesText(rules)).toBe(text);
    expect(() => parseRules('IF TANK 1 LEVEL > 1')).toThrow(EditError);
  });
});
