import { existsSync, readFileSync } from 'node:fs';
import { EngineSync, loadModel, setField, Store, toModel } from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { EngineClient } from './client.ts';
import { handle } from './handle.ts';
import { EngineError, type EngineRequest, type EngineResponse } from './protocol.ts';
import { instantiateEngine, type Engine } from './wasm.ts';

const wasmPath = new URL('../wasm/ws_wasm.wasm', import.meta.url);
const have = existsSync(wasmPath);
const root = new URL('../../../', import.meta.url);

/** A worker running the real engine in-process, counting what it is sent. */
class FakeWorker {
  onmessage: ((e: MessageEvent<EngineResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly sent: EngineRequest[] = [];
  engine: Engine;
  constructor(engine: Engine) {
    this.engine = engine;
  }
  postMessage(req: EngineRequest): void {
    this.sent.push(req);
    let res: EngineResponse;
    try {
      res = { id: req.id, ok: true, reply: handle(this.engine, req), ms: 0 };
    } catch (e) {
      res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    queueMicrotask(() => this.onmessage?.({ data: res } as MessageEvent<EngineResponse>));
  }
  terminate(): void {}
  kinds(): string[] {
    return this.sent.map((r) => r.kind);
  }
}

describe.skipIf(!have)('resident models (ADR 0020)', async () => {
  const bytes = have ? readFileSync(wasmPath) : new Uint8Array();
  const fresh = () => instantiateEngine(bytes);
  const NET1 = have
    ? (await fresh()).readInp(readFileSync(new URL('apps/web/public/samples/Net1.inp', root), 'utf8')).model
    : null;
  const net1 = () => {
    const store = new Store();
    loadModel(store, NET1!);
    return store;
  };

  it('an engine holding the document runs it as it runs the whole model', async () => {
    const e = await fresh();
    const store = net1();
    const sync = new EngineSync(store);
    e.sessionOpen(sync.snapshot());
    const ref = () => ({ epoch: sync.epoch, rev: sync.rev });
    expect(e.run(ref()).link.flow).toEqual(e.run(toModel(store.doc)).link.flow);

    const from = sync.rev;
    setField(store, [store.doc.findLink('10')!], 'diameter', 12);
    setField(store, [store.doc.findNode('22')!], 'elevation', 700);
    e.sessionPatch(sync.patch(from)!);
    const resident = e.run(ref());
    expect(resident.link.flow).toEqual(e.run(toModel(store.doc)).link.flow);
    expect(resident.node.head).toEqual(e.run(toModel(store.doc)).node.head);

    // Studies, checks and files take the resident model too.
    const opts = { hydrants: ['32'], flow: 500, residual: 20 };
    expect(e.study({ kind: 'fireFlow', model: ref(), options: opts })).toEqual(
      e.study({ kind: 'fireFlow', model: toModel(store.doc), options: opts }),
    );
    expect(e.check(ref())).toBeNull();
    const date = 'Tue Oct 13 05:00:00 2026';
    const files = { inpName: 'Net1.inp', date, statusLog: false };
    expect(e.runFiles({ model: ref(), ...files }).report).toBe(
      e.runFiles({ model: toModel(store.doc), ...files }).report,
    );

    // A reference to a revision it does not hold is refused, not answered.
    expect(() => e.run({ epoch: sync.epoch, rev: from })).toThrow(/^stale session/);
    expect(() => e.check({ epoch: sync.epoch + 1, rev: sync.rev })).toThrow(/^stale session/);

    // The model carries over to a fresh instance (as a worker recycles its engine).
    const next = await fresh();
    next.sessionOpen(e.sessionExport()!);
    expect(next.run(ref()).link.flow).toEqual(resident.link.flow);
    expect((await fresh()).sessionExport()).toBeNull();
  });

  it('the client sends the model once, then only edits, and recovers a lost one', async () => {
    const workers: FakeWorker[] = [];
    const engines = [await fresh(), await fresh()];
    const client = new EngineClient({
      workers: 2,
      factory: () => {
        const w = new FakeWorker(engines[workers.length]!);
        workers.push(w);
        return w as unknown as Worker;
      },
    });
    const store = net1();
    const sync = new EngineSync(store);

    const a = await client.run(sync);
    expect(workers[0]!.kinds()).toEqual(['session-open', 'run']);
    const again = await client.run(sync);
    expect(again.value.link.flow).toEqual(a.value.link.flow);
    expect(workers[0]!.kinds()).toEqual(['session-open', 'run', 'run']); // nothing resent

    setField(store, [store.doc.findLink('10')!], 'diameter', 10);
    const b = await client.run(sync);
    const patch = workers[0]!.sent.at(-2)!;
    expect(patch.kind).toBe('session-patch');
    if (patch.kind === 'session-patch') expect(patch.patch.links.map((l) => l.slot)).toHaveLength(1);
    expect(b.value.link.flow).toEqual(engines[0]!.run(toModel(store.doc)).link.flow);

    // A study spread over both workers opens the second one once.
    const hydrants = ['11', '12', '13', '21', '22', '23', '31', '32'];
    await Promise.all(
      [hydrants.slice(0, 4), hydrants.slice(4)].map((h) =>
        client.study({ kind: 'fireFlow', model: sync, options: { hydrants: h, flow: 500, residual: 20 } }),
      ),
    );
    expect(workers[1]!.kinds().filter((k) => k === 'session-open')).toHaveLength(1);

    // An engine that lost its model (a crash, a new instance) refuses the reference; the
    // request is answered by the other engine, and the first gets a snapshot when next used.
    workers[0]!.engine = await fresh();
    const c = await client.run(sync);
    expect(c.value.link.flow).toEqual(b.value.link.flow);
    expect(workers[0]!.kinds().at(-1)).toBe('run');
    expect(workers[1]!.kinds()).toEqual(['session-open', 'study', 'run']);
    await Promise.all([client.run(sync), client.run(sync)]);
    expect(workers[0]!.kinds().slice(-2)).toEqual(['session-open', 'run']);

    // Errors that are not about the session still reach the caller.
    store.transact('Bad rule', (tx) =>
      tx.setDoc('rules', [
        { name: '1', lines: ['RULE 1', 'IF SYSTEM TIME > 2', 'THEN LINK P9 STATUS IS OPEN'] },
      ]),
    );
    expect((await client.check(sync)).value).toMatch(/undefined link P9/);
    await expect(client.run(sync)).rejects.toThrow(EngineError);
    client.dispose();
  });
});
