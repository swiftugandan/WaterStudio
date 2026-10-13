import {
  emptyCriteria,
  loadModel,
  Store,
  unitSystem,
  type Criteria,
  type Document,
  type model,
} from '@waterstudio/core';
import type { RunResults } from '@waterstudio/engine-client';
import { describe, expect, it } from 'vitest';
import { independentCheck, reviewProposal } from './checker.ts';
import { assess, describeAssessment } from './criteria.ts';
import { draftContext, DRAFT_TOOLS, type AgentHost } from './draft.ts';
import { Sandbox, type ProposalDraft } from './proposal.ts';
import type { Completion, CompletionRequest, Provider } from './providers.ts';
import { ToolRegistry } from './registry.ts';
import { READ_TOOLS } from './tools.ts';

const section = (lines: string[][] = []) => ({ lines: lines.map((tokens) => ({ tokens, comment: null })) });

/** R feeds A, B, C in a line; pressure falls with elevation, velocity with diameter (stand-in engine). */
function network(): model.Model {
  const j = (id: string, x: number, elevation: number): model.Node => ({
    id,
    kind: {
      type: 'junction',
      elevation,
      demands: [{ base: 1, pattern: null, category: null }],
      emitter: null,
    },
    comment: null,
    tag: null,
    coordinates: [x, 0],
    initialQuality: null,
    source: null,
  });
  const pipe = (id: string, from: string, to: string, diameter: number): model.Link => ({
    id,
    from,
    to,
    kind: {
      type: 'pipe',
      length: 100,
      diameter,
      roughness: 100,
      minorLoss: 0,
      status: 'open',
      leakage: null,
      bulkCoeff: null,
      wallCoeff: null,
    },
    comment: null,
    tag: null,
    vertices: [],
  });
  return {
    title: ['Test'],
    nodes: [
      {
        id: 'R',
        kind: { type: 'reservoir', head: 100, pattern: null, level: 0 },
        comment: null,
        tag: null,
        coordinates: [0, 0],
        initialQuality: null,
        source: null,
      },
      j('A', 100, 10),
      j('B', 200, 20),
      j('C', 300, 30),
    ],
    links: [pipe('P1', 'R', 'A', 12), pipe('P2', 'A', 'B', 8), pipe('P3', 'B', 'C', 6)],
    patterns: [],
    curves: [],
    controls: [],
    rules: [],
    options: section([['Units', 'GPM']]),
    times: section([['Duration', '1:00']]),
    report: section(),
    energy: section(),
    reactions: section(),
    backdrop: section(),
    labels: [],
    extraSections: [],
  };
}

function run(doc: Document): RunResults {
  const nodes = [...doc.nodeHandles()];
  const links = [...doc.linkHandles()];
  const col = (xs: number[]) => Float32Array.from(xs);
  if (links.some((h) => doc.num(h, 'diameter') <= 1)) throw new Error('EPANET error 110: cannot solve');
  return {
    engine: 'test',
    reportStart: 0,
    reportStep: 3600,
    times: [0, 3600],
    nodeCount: nodes.length,
    linkCount: links.length,
    warning: 0,
    node: {
      demand: col([...nodes, ...nodes].map(() => 1)),
      pressure: col(
        [...nodes, ...nodes].map((h) => (doc.nodeKind(h) === 'junction' ? 40 - doc.num(h, 'elevation') : 0)),
      ),
      quality: col([...nodes, ...nodes].map(() => 0)),
    },
    link: {
      velocity: col([...links, ...links].map((h) => 30 / doc.num(h, 'diameter'))),
      headloss: col([...links, ...links].map(() => 1)),
    },
  } as unknown as RunResults;
}

function store(criteria: Partial<Criteria> = {}): Store {
  const s = new Store();
  loadModel(s, network());
  s.transact('Criteria', (tx) => tx.setDoc('criteria', { ...emptyCriteria(), ...criteria }));
  return s;
}

const view = (doc: Document) => ({
  results: run(doc),
  nodes: Uint32Array.from(doc.nodeHandles()),
  links: Uint32Array.from(doc.linkHandles()),
  stale: false,
});

describe('design criteria', () => {
  it('finds the junctions and pipes outside each limit, worst first', () => {
    const s = store();
    // Pressures: A 30, B 20, C 10. Velocities: P1 2.5, P2 3.75, P3 5.
    const a = assess(s.doc, view(s.doc), {
      minPressure: 25,
      maxVelocity: 4,
      maxHeadloss: 2,
      minResidual: 0.2,
    });
    expect(a.pass).toBe(false);
    const by = Object.fromEntries(a.checked.map((c) => [c.criterion, c]));
    expect(by['minPressure']).toMatchObject({
      limit: 25,
      elements: 2,
      worst: [{ id: 'C', value: 10 }, { id: 'B' }],
    });
    expect(by['maxVelocity']).toMatchObject({ elements: 1, worst: [{ id: 'P3', value: 5 }] });
    expect(by['maxHeadloss']!.elements).toBe(0);
    // No chemical is modelled, so the residual cannot be checked.
    expect(a.skipped).toEqual([
      { criterion: 'minResidual', reason: expect.stringMatching(/chemical/) as string },
    ]);
    expect(describeAssessment(a)).toEqual([
      'Minimum pressure 25: 2 junctions outside it, worst C at 10 (hour 0)',
      'Maximum velocity 4: 1 pipe outside it, worst P3 at 5 (hour 0)',
    ]);
  });

  it("find_violations and check_criteria use the project's criteria", async () => {
    const s = store({ minPressure: 15 });
    const registry = new ToolRegistry(READ_TOOLS);
    const ctx = draftContext(host(s, []));
    await registry.call('run_analysis', {}, ctx);
    expect(await registry.call('find_violations', {}, ctx)).toMatchObject({
      ok: true,
      value: { min_pressure: { limit: 15, elements: 1, worst: [{ id: 'C' }] } },
    });
    expect(await registry.call('check_criteria', {}, ctx)).toMatchObject({
      ok: true,
      value: { pass: false },
    });
    expect(await registry.call('get_design_criteria', {}, ctx)).toMatchObject({
      ok: true,
      value: { minPressure: { limit: 15, units: 'psi' }, maxVelocity: { limit: null } },
    });
    // Limits given in the call replace the profile.
    expect(await registry.call('find_violations', { min_pressure: 5 }, ctx)).toMatchObject({
      ok: true,
      value: { min_pressure: { elements: 0 } },
    });
  });
});

function host(s: Store, queue: ProposalDraft[]): AgentHost {
  return {
    units: unitSystem(s.doc.data.options),
    fileName: 'test.inp',
    author: 'test agent',
    doc: () => s.doc,
    period: () => 0,
    run: (doc) => Promise.resolve(run(doc)),
    files: () => Promise.resolve({ report: '', out: new Uint8Array() }),
    submit: (p) => {
      queue.push(p);
      return `P${queue.length}`;
    },
  };
}

describe('submitting against the criteria', () => {
  const registry = new ToolRegistry([...READ_TOOLS, ...DRAFT_TOOLS]);
  const all = ['read', 'analyse', 'draft', 'propose'] as const;

  it('is refused while a criterion is broken and unexplained, and records the explanation', async () => {
    const s = store({ maxVelocity: 4 });
    const queue: ProposalDraft[] = [];
    const ctx = draftContext(host(s, queue));
    await registry.call('set_properties', { links: ['P2'], values: { diameter: 10 } }, ctx, all);
    let r = await registry.call(
      'submit_proposal',
      { title: 'Bigger P2', rationale: 'Lower velocity.' },
      ctx,
      all,
    );
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/still breaks.*Maximum velocity 4: 1 pipe.*P3.*unmet/);
    expect(queue).toHaveLength(0);
    r = await registry.call(
      'submit_proposal',
      {
        title: 'Bigger P2',
        rationale: 'Lower velocity.',
        unmet: [{ criterion: 'maxVelocity', reason: 'P3 is in a separate project.' }],
      },
      ctx,
      all,
    );
    expect(r.ok).toBe(true);
    expect(queue[0]!.evidence.unmet).toEqual([
      { criterion: 'maxVelocity', reason: 'P3 is in a separate project.' },
    ]);
    expect(queue[0]!.evidence.criteria!.before!.checked[0]!.elements).toBe(1);
    expect(queue[0]!.evidence.criteria!.after!.checked[0]!.elements).toBe(1);
  });

  it('goes through when the draft meets every criterion', async () => {
    const s = store({ maxVelocity: 4 });
    const queue: ProposalDraft[] = [];
    const ctx = draftContext(host(s, queue));
    await registry.call('set_properties', { links: ['P2', 'P3'], values: { diameter: 10 } }, ctx, all);
    const r = await registry.call('submit_proposal', { title: 'Bigger', rationale: 'Velocity.' }, ctx, all);
    expect(r).toMatchObject({ ok: true, value: { criteria: [] } });
  });
});

function change(s: Store, edit: (sb: Sandbox) => void) {
  const sb = new Sandbox(s.doc);
  edit(sb);
  return sb.changes();
}

describe('the independent checker', () => {
  it('passes a change that meets the criteria it did not meet', async () => {
    const s = store({ maxVelocity: 4 });
    const items = change(s, (sb) =>
      sb.store.transact('e', (tx) => tx.set(sb.draft.findLink('P3')!, 'diameter', 10)),
    );
    const r = await independentCheck({
      base: s.doc,
      items,
      criteria: s.doc.data.criteria,
      run: (d) => Promise.resolve(run(d)),
    });
    expect(r.verdict).toBe('pass');
    expect(r.applied).toBe(1);
    expect(r.before!.pass).toBe(false);
    expect(r.after!.pass).toBe(true);
  });

  it('fails a change that breaks a criterion that was met, or more elements of one that was not', async () => {
    const s = store({ maxVelocity: 4, minPressure: 5 });
    let items = change(s, (sb) =>
      sb.store.transact('e', (tx) => tx.set(sb.draft.findNode('A')!, 'elevation', 38)),
    );
    let r = await independentCheck({
      base: s.doc,
      items,
      criteria: s.doc.data.criteria,
      run: (d) => Promise.resolve(run(d)),
    });
    expect(r.verdict).toBe('fail');
    expect(r.findings.map((f) => f.text).join(' ')).toMatch(/Minimum pressure \(5\) was met and now is not/);
    items = change(s, (sb) =>
      sb.store.transact('e', (tx) => tx.set(sb.draft.findLink('P2')!, 'diameter', 6)),
    );
    r = await independentCheck({
      base: s.doc,
      items,
      criteria: s.doc.data.criteria,
      run: (d) => Promise.resolve(run(d)),
    });
    expect(r.verdict).toBe('fail');
    expect(r.findings[0]!.text).toMatch(/broken at more elements: 1 before, 2 after/);
  });

  it('raises a concern for a criterion still unmet and for changes that no longer apply', async () => {
    const s = store({ maxVelocity: 4 });
    const items = change(s, (sb) =>
      sb.store.transact('e', (tx) => {
        tx.set(sb.draft.findNode('B')!, 'elevation', 21);
        tx.set(sb.draft.findNode('C')!, 'elevation', 29);
      }),
    );
    // Meanwhile the engineer edits B.
    s.transact('meanwhile', (tx) => tx.set(s.doc.findNode('B')!, 'elevation', 25));
    const r = await independentCheck({
      base: s.doc,
      items,
      criteria: s.doc.data.criteria,
      run: (d) => Promise.resolve(run(d)),
    });
    expect(r.verdict).toBe('concerns');
    expect(r.conflicts).toHaveLength(1);
    expect(r.findings.map((f) => f.severity)).toEqual(['concern', 'concern']);
  });

  it('fails a change after which the network does not solve, and notes when no criteria are set', async () => {
    const s = store();
    const items = change(s, (sb) =>
      sb.store.transact('e', (tx) => tx.set(sb.draft.findLink('P2')!, 'diameter', 1)),
    );
    const r = await independentCheck({
      base: s.doc,
      items,
      criteria: s.doc.data.criteria,
      run: (d) => Promise.resolve(run(d)),
    });
    expect(r.verdict).toBe('fail');
    expect(r.after).toBeNull();
    expect(r.findings.map((f) => f.text)).toEqual([
      'The changed network does not solve: EPANET error 110: cannot solve',
      'No design criteria are set; the change was checked only for solving and for EPANET warnings.',
    ]);
  });

  it("asks a second assistant, which sees the changes but not the producer's reasons", async () => {
    const s = store({ maxVelocity: 4 });
    const items = change(s, (sb) =>
      sb.store.transact('e', (tx) => tx.set(sb.draft.findLink('P3')!, 'diameter', 10)),
    );
    const check = await independentCheck({
      base: s.doc,
      items,
      criteria: s.doc.data.criteria,
      run: (d) => Promise.resolve(run(d)),
    });
    const seen: CompletionRequest[] = [];
    let step = 0;
    const provider: Provider = {
      complete: (req): Promise<Completion> => {
        seen.push(structuredClone(req));
        step++;
        if (step === 1)
          return Promise.resolve({
            content: [{ type: 'tool_use', id: 't1', name: 'run_analysis', input: {} }],
            stopReason: 'tool_use',
          });
        if (step === 2)
          return Promise.resolve({
            content: [{ type: 'tool_use', id: 't2', name: 'check_criteria', input: {} }],
            stopReason: 'tool_use',
          });
        if (step === 3)
          return Promise.resolve({
            content: [
              {
                type: 'tool_use',
                id: 't3',
                name: 'report_verdict',
                input: { verdict: 'approve', notes: 'P3 now 3 ft/s.' },
              },
            ],
            stopReason: 'tool_use',
          });
        return Promise.resolve({ content: [{ type: 'text', text: 'Done.' }], stopReason: 'end_turn' });
      },
    };
    const review = await reviewProposal({
      provider,
      author: 'checker',
      base: s.doc,
      items,
      check,
      units: unitSystem(s.doc.data.options),
      fileName: 'test.inp',
      run: (d) => Promise.resolve(run(d)),
    });
    expect(review).toEqual({ verdict: 'approve', notes: 'P3 now 3 ft/s.', author: 'checker' });
    // It looked at the changed network: the criteria pass there.
    const toolResults = JSON.stringify(seen.at(-1)!.messages);
    expect(toolResults).toContain('\\"pass\\":true');
    // Its brief holds the changes, criteria and engine findings: no rationale, no title, no author.
    const brief = JSON.stringify(seen[0]!.messages[0]);
    expect(brief).toContain('maxVelocity');
    expect(brief).not.toMatch(/rationale|title|test agent/);
    expect(seen[0]!.tools.map((t) => t.name)).toContain('report_verdict');
    expect(seen[0]!.tools.map((t) => t.name)).not.toContain('submit_proposal');
  });
});
