import { loadModel, Store, unitSystem, type model } from '@waterstudio/core';
import type { RunResults } from '@waterstudio/engine-client';
import { describe, expect, it } from 'vitest';
import type { Completion, CompletionRequest, Provider } from './providers.ts';
import { openAiProvider, toOpenAi } from './providers.ts';
import { matches, parseQuery, QueryError } from './query.ts';
import { ToolRegistry, type AgentContext, type RunView } from './registry.ts';
import { validate } from './schema.ts';
import { AssistantSession, type SessionEvent } from './session.ts';
import { READ_TOOLS } from './tools.ts';

const section = (lines: string[][] = []) => ({ lines: lines.map((tokens) => ({ tokens, comment: null })) });

function network(): model.Model {
  const j = (id: string, elevation: number, base: number): model.Node => ({
    id,
    kind: { type: 'junction', elevation, demands: [{ base, pattern: null, category: null }], emitter: null },
    comment: null,
    tag: null,
    coordinates: [0, 0],
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
      status: id === 'P3' ? 'closed' : 'open',
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
      j('A', 10, 1),
      j('B', 50, 2),
      j('C', 80, 3),
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
    backdrop: section([['CRS', 'EPSG:32633']]),
    labels: [],
    extraSections: [],
  };
}

function context(withResults = true): AgentContext {
  const store = new Store();
  loadModel(store, network());
  const doc = store.doc;
  const nodes = Uint32Array.from(doc.nodeHandles());
  const links = Uint32Array.from(doc.linkHandles());
  // Two periods; pressures fall in period 1. Node order: R, A, B, C.
  const col = (n: number, f: (p: number, i: number) => number) =>
    Float32Array.from({ length: 2 * n }, (_, k) => f(Math.floor(k / n), k % n));
  const results = {
    engine: 'test',
    reportStart: 0,
    reportStep: 3600,
    times: [0, 3600],
    nodeCount: 4,
    linkCount: 3,
    warning: 6,
    node: {
      demand: col(4, (_, i) => [-6, 1, 2, 3][i]!),
      head: col(4, (p, i) => 100 - 5 * i - p),
      pressure: col(4, (p, i) => [0, 39, 21, -5][i]! - p * 10),
      quality: col(4, () => 0),
    },
    link: {
      flow: col(3, (_, i) => [6, 5, 0][i]!),
      velocity: col(3, (p, i) => [1.2, 2.5, 0][i]! + p),
      headloss: col(3, (_, i) => [1, 4, 0][i]!),
      status: col(3, (_, i) => (i === 2 ? 2 : 3)),
    },
  } as unknown as RunResults;
  const view: RunView = { results, nodes, links, stale: false };
  return {
    doc,
    units: unitSystem(doc.data.options),
    fileName: 'test.inp',
    results: () => (withResults ? view : null),
    period: () => 0,
    analyse: () => Promise.resolve(view),
    files: () =>
      Promise.resolve({
        report: 'x\n  Hydraulic Status:\n  0:00:00: Balanced after 2 trials\n  Analysis ended',
        out: new Uint8Array(),
      }),
  };
}

const registry = new ToolRegistry(READ_TOOLS);

describe('query language', () => {
  const row: Record<string, string | number> = { type: 'junction', pressure: 18, id: 'J1', zone: 'North' };
  const q = (s: string) => matches(parseQuery(s), (f) => row[f]);

  it('compares numbers and text', () => {
    expect(q('pressure < 20')).toBe(true);
    expect(q('pressure < 20 psi and type = Junction')).toBe(true);
    expect(q('pressure >= 20 or zone = "north"')).toBe(true);
    expect(q('not (type = junction)')).toBe(false);
    expect(q('missing = 3')).toBe(false);
    expect(q('missing != 3')).toBe(true);
  });

  it('gives and precedence over or', () => {
    expect(q('pressure > 100 and type = tank or id = J1')).toBe(true);
    expect(q('pressure > 100 and (type = tank or id = J1)')).toBe(false);
  });

  it('reports syntax errors', () => {
    expect(() => parseQuery('pressure <')).toThrow(QueryError);
    expect(() => parseQuery('(pressure < 3')).toThrow('Missing ")"');
    expect(() => parseQuery('pressure 3')).toThrow(QueryError);
  });
});

describe('schema validation', () => {
  it('checks types, enums, ranges and unknown properties', () => {
    const s = {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 1 }, t: { type: 'string', enum: ['a', 'b'] } },
      required: ['n'],
      additionalProperties: false,
    } as const;
    expect(validate(s, { n: 2, t: 'a' })).toEqual([]);
    expect(validate(s, { n: 0.5, t: 'c', x: 1 })).toEqual([
      'input.n must be an integer',
      'input.t must be one of a, b',
      'input.x is not a known property',
    ]);
    expect(validate(s, {})).toEqual(['input.n is required']);
  });
});

describe('read-only tools', () => {
  it('summarises the project', async () => {
    const r = await registry.call('get_project_summary', {}, context());
    expect(r.ok && r.value).toMatchObject({
      counts: { reservoir: 1, junction: 3, pipe: 3 },
      units: { flow: 'GPM', pressure: 'psi' },
      coordinateSystem: 'EPSG:32633',
      results: { periods: 2, warning: 'the system has negative pressures' },
    });
  });

  it('queries fields and results together', async () => {
    const r = await registry.call(
      'query_elements',
      { query: 'type = junction and pressure < 25', fields: ['pressure', 'elevation'] },
      context(),
    );
    expect(r.ok && r.value).toMatchObject({
      total: 2,
      elements: [
        { id: 'B', pressure: 21, elevation: 50 },
        { id: 'C', pressure: -5, elevation: 80 },
      ],
    });
    const closed = await registry.call('query_elements', { query: 'pipeStatus = closed' }, context());
    expect(closed.ok && closed.value).toMatchObject({ total: 1, elements: [{ id: 'P3' }] });
    const bad = await registry.call('query_elements', { query: 'presure < 3' }, context());
    expect(bad).toEqual({ ok: false, error: 'Unknown field or variable: presure' });
  });

  it('describes one element with units and results', async () => {
    const r = await registry.call('get_element', { id: 'P2', period: 1 }, context());
    expect(r.ok && r.value).toMatchObject({
      type: 'pipe',
      from: 'A',
      to: 'B',
      diameter: 8,
      pipeStatus: 'open',
      units: { diameter: 'in' },
      results: { atHours: 1, velocity: 3.5 },
    });
  });

  it('slices results with the lowest and highest', async () => {
    const r = await registry.call(
      'get_results_slice',
      { variable: 'pressure', types: ['junction'], top: 1 },
      context(),
    );
    expect(r.ok && r.value).toMatchObject({
      stats: { count: 3, min: -5, max: 39 },
      lowest: [{ id: 'C', value: -5 }],
      highest: [{ id: 'A', value: 39 }],
    });
  });

  it('finds design limit violations over time', async () => {
    const r = await registry.call('find_violations', { min_pressure: 20, max_velocity: 3 }, context());
    expect(r.ok && r.value).toMatchObject({
      min_pressure: {
        elements: 2,
        worst: [
          { id: 'C', value: -15, atHours: 1 },
          { id: 'B', value: 11, atHours: 1 },
        ],
      },
      max_velocity: { elements: 1, worst: [{ id: 'P2', value: 3.5, atHours: 1 }] },
    });
  });

  it('returns time series and the status log', async () => {
    const t = await registry.call('get_timeseries', { ids: ['A'], variable: 'head' }, context());
    expect(t.ok && t.value).toMatchObject({ hours: [0, 1], series: { A: [95, 94] } });
    const s = await registry.call('get_status_report', {}, context());
    expect(s.ok && s.value).toMatchObject({ log: 'Hydraulic Status:\n0:00:00: Balanced after 2 trials' });
  });

  it('asks for a run when there are no results, and checks arguments', async () => {
    const r = await registry.call('get_results_slice', { variable: 'pressure' }, context(false));
    expect(r).toEqual({ ok: false, error: 'There are no results yet. Call run_analysis first.' });
    const bad = await registry.call('get_timeseries', { ids: [], variable: 'head' }, context());
    expect(bad.ok).toBe(false);
    expect(await registry.call('drop_tables', {}, context())).toEqual({
      ok: false,
      error: 'There is no tool named drop_tables.',
    });
  });
});

describe('assistant session', () => {
  it('runs tools the model asks for and ends with its answer', async () => {
    const requests: CompletionRequest[] = [];
    const replies: Completion[] = [
      {
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 't1', name: 'get_results_slice', input: { variable: 'pressure', top: 1 } },
        ],
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Junction C has the lowest pressure: -5 psi.' }],
        stopReason: 'end_turn',
      },
    ];
    const provider: Provider = {
      complete: (req) => {
        requests.push(structuredClone(req));
        return Promise.resolve(replies.shift()!);
      },
    };
    const events: SessionEvent[] = [];
    const s = new AssistantSession(provider, registry, context());
    await s.send('Where is pressure lowest?', (e) => events.push(e));
    expect(events.map((e) => e.kind)).toEqual(['text', 'tool', 'tool-result', 'text']);
    expect(requests[0]!.tools.map((t) => t.name)).toContain('find_violations');
    const second = requests[1]!.messages;
    expect(second).toHaveLength(3);
    const result = second[2]!.content[0]!;
    expect(result.type === 'tool_result' && JSON.parse(result.content)).toMatchObject({
      lowest: [{ id: 'C' }],
    });
  });

  it('reports provider failures without breaking the conversation', async () => {
    const s = new AssistantSession(
      { complete: () => Promise.reject(new Error('401 bad key')) },
      registry,
      context(),
    );
    const events: SessionEvent[] = [];
    await s.send('hi', (e) => events.push(e));
    expect(events).toEqual([{ kind: 'error', message: '401 bad key' }]);
    expect(s.messages).toEqual([]);
  });
});

describe('OpenAI-compatible provider', () => {
  it('translates tool calls both ways', async () => {
    const msgs = toOpenAi('sys', [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'get_element', input: { id: 'A' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '{}' }] },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    const fetcher = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  tool_calls: [{ id: 'c2', function: { name: 'run_analysis', arguments: '{}' } }],
                },
              },
            ],
          }),
        ),
      );
    const p = openAiProvider(
      { kind: 'openai', endpoint: 'http://localhost:1/v1/chat/completions', model: 'm' },
      fetcher,
    );
    const out = await p.complete({ system: 's', messages: [], tools: [], maxTokens: 10 });
    expect(out).toEqual({
      content: [{ type: 'tool_use', id: 'c2', name: 'run_analysis', input: {} }],
      stopReason: 'tool_use',
    });
  });
});
