import { addLink, addNode, Store } from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { Camera } from './camera.ts';
import { Picker } from './picking.ts';
import { applyScenePatch, buildScene, LINK_SYMBOLS, patchScene } from './scene.ts';
import { packColor, strokeLine } from './raster.ts';
import { classify, legendFor, quantileBreaks, rampColors } from './style.ts';

function network() {
  const store = new Store();
  const r = addNode(store, 'reservoir', { x: 1000, y: 2000, id: 'R' });
  const a = addNode(store, 'junction', { x: 1100, y: 2000, id: 'A' });
  const b = addNode(store, 'junction', { x: 1200, y: 2100, id: 'B' });
  const t = addNode(store, 'tank', { x: 1300, y: 2100, id: 'T' });
  const p1 = addLink(store, 'pipe', { from: r, to: a, id: 'P1' });
  const p2 = addLink(store, 'pipe', { from: a, to: b, id: 'P2', vertices: [1200, 2000] });
  const pu = addLink(store, 'pump', { from: b, to: t, id: 'PU' });
  return { store, r, a, b, t, p1, p2, pu };
}

describe('camera', () => {
  it('maps world and screen both ways, y up', () => {
    const c = new Camera();
    c.resize(800, 600);
    c.set({ cx: 100, cy: 50, scale: 2 });
    expect(c.toScreen(100, 50)).toEqual([400, 300]);
    expect(c.toScreen(110, 60)).toEqual([420, 280]);
    expect(c.toWorld(420, 280)).toEqual([110, 60]);
  });

  it('zooms about the cursor', () => {
    const c = new Camera();
    c.resize(800, 600);
    const before = c.toWorld(100, 100);
    c.zoomAt(3, 100, 100);
    expect(c.toWorld(100, 100)[0]).toBeCloseTo(before[0], 9);
    expect(c.toWorld(100, 100)[1]).toBeCloseTo(before[1], 9);
    expect(c.scale).toBe(3);
  });

  it('fits bounds', () => {
    const c = new Camera();
    c.resize(200, 100);
    c.fit({ minX: 0, minY: 0, maxX: 100, maxY: 10 }, 0);
    expect(c.scale).toBe(2);
    expect([c.cx, c.cy]).toEqual([50, 5]);
  });
});

describe('scene', () => {
  it('lays out nodes, segments and symbols relative to an origin', () => {
    const { store, r, pu } = network();
    const s = buildScene(store.doc);
    expect([s.nodeCount, s.linkCount, s.segCount, s.symCount]).toEqual([4, 3, 4, 1]);
    expect([s.originX, s.originY]).toEqual([1150, 2050]);
    expect(Array.from(s.nodeXY.subarray(0, 2))).toEqual([-150, -50]);
    expect(s.nodeHandles[0]).toBe(r);
    expect(s.nodeKind[3]).toBe(2); // tank
    expect(LINK_SYMBOLS[s.linkSymbol[2]!]).toBe('pump');
    expect(s.symLink[0]).toBe(2);
    expect(s.linkHandles[2]).toBe(pu);
    // The pump's symbol sits at its midpoint, pointing along +x.
    expect(Array.from(s.symXY)).toEqual([100, 50]);
    expect(s.symAngle[0]).toBe(0);
    expect(s.typicalLength).toBe(100);
  });

  it('skips nodes without coordinates and links to them', () => {
    const store = new Store();
    const a = addNode(store, 'junction', { x: NaN, y: NaN, id: 'A' });
    const b = addNode(store, 'junction', { x: 0, y: 0, id: 'B' });
    addLink(store, 'pipe', { from: a, to: b });
    const s = buildScene(store.doc);
    expect([s.nodeCount, s.linkCount, s.segCount]).toEqual([2, 1, 0]);
  });
});

describe('legend', () => {
  it('classifies values into colour classes', () => {
    const legend = { breaks: [10, 20], colors: ['a', 'b', 'c'] };
    expect(Array.from(classify([5, 10, 15, 25, NaN], legend))).toEqual([1, 2, 2, 3, 0]);
  });

  it('builds nice quantile breaks', () => {
    const v = Array.from({ length: 100 }, (_, i) => i * 1.01);
    expect(quantileBreaks(v, 5)).toEqual([20, 40, 61, 81]);
    expect(legendFor(v).colors).toHaveLength(5);
    expect(rampColors('epanet', 5)).toEqual(['#0000ff', '#00ffff', '#00ff00', '#ffff00', '#ff0000']);
  });
});

describe('picking', () => {
  it('finds the nearest node, else link, within tolerance', () => {
    const { store, a, p2 } = network();
    const s = buildScene(store.doc);
    const c = new Camera();
    c.resize(400, 400);
    c.fit(s.bounds, 0);
    const p = new Picker(s);
    const [ax, ay] = c.toScreen(1100, 2000);
    expect(p.pick(c, ax + 2, ay)?.handle).toBe(a);
    const [mx, my] = c.toScreen(1200, 2050); // on P2's second segment
    expect(p.pick(c, mx + 1, my)?.handle).toBe(p2);
    expect(p.pick(c, 0, 399)).toBeNull();
  });

  it('selects by window or crossing', () => {
    const { store } = network();
    const s = buildScene(store.doc);
    const p = new Picker(s);
    const win = p.query({ minX: 1050, minY: 1950, maxX: 1250, maxY: 2150 });
    expect(win.nodes.sort()).toEqual([1, 2]);
    expect(win.links).toEqual([1]); // P2 only; P1 and the pump cross the edge
    const cross = p.query({ minX: 1050, minY: 1950, maxX: 1250, maxY: 2150 }, true);
    expect(cross.links.sort()).toEqual([0, 1, 2]);
  });
});

describe('overview rasteriser', () => {
  it('packs hex colours as RGBA pixels', () => {
    expect(packColor('#ff8000')).toBe(0xff0080ff);
    expect(packColor('#f80')).toBe(0xff0088ff);
    expect(packColor('red')).toBeNull();
  });

  it('draws clipped square-brushed lines', () => {
    const w = 10;
    const h = 6;
    const buf = new Uint32Array(w * h);
    strokeLine(buf, w, h, -5, 2, 4, 2, 1, 7);
    const row = (y: number) => [...buf.slice(y * w, (y + 1) * w)];
    expect(row(2)).toEqual([7, 7, 7, 7, 7, 0, 0, 0, 0, 0]);
    buf.fill(0);
    strokeLine(buf, w, h, 2, 1, 2, 3, 2, 9);
    expect(row(0)).toEqual(new Array<number>(w).fill(0));
    expect(row(1).slice(0, 4)).toEqual([0, 0, 9, 9]);
    expect(row(3).slice(0, 4)).toEqual([0, 0, 9, 9]);
    buf.fill(0);
    strokeLine(buf, w, h, 20, 20, 30, 30, 3, 5);
    expect(buf.every((v) => v === 0)).toBe(true);
  });
});

describe('scene patches', () => {
  it('move nodes, their links and symbols in place, matching a new scene', () => {
    const { store, b, t, p2, pu } = network();
    const scene = buildScene(store.doc);
    const copy = buildScene(store.doc);
    store.transact('move', (tx) => {
      tx.set(b, 'x', 1250);
      tx.set(b, 'y', 2050);
    });
    const ni = [...scene.nodeHandles].indexOf(b);
    const li = [p2, pu].map((h) => [...scene.linkHandles].indexOf(h));
    const patch = patchScene(scene, store.doc, [ni], li)!;
    expect(patch).not.toBeNull();
    const fresh = buildScene(store.doc);
    expect([...scene.nodeXY]).toEqual([...fresh.nodeXY]);
    expect([...scene.segXY]).toEqual([...fresh.segXY]);
    expect([...scene.symXY]).toEqual([...fresh.symXY]);
    applyScenePatch(copy, patch);
    expect([...copy.segXY]).toEqual([...fresh.segXY]);
    expect([...copy.symAngle]).toEqual([...fresh.symAngle]);
    // A new vertex, or leaving the bounds, needs a new scene.
    store.transact('vertex', (tx) => tx.set(p2, 'vertices', [1200, 2000, 1220, 2010]));
    expect(patchScene(scene, store.doc, [], [li[0]!])).toBeNull();
    store.transact('far', (tx) => tx.set(t, 'x', 9999));
    expect(patchScene(scene, store.doc, [[...scene.nodeHandles].indexOf(t)], [li[1]!])).toBeNull();
  });
});
