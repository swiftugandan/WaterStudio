import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposalsFromText } from '@waterstudio/agents';
import { emptyCriteria } from '@waterstudio/core';
import { afterAll, describe, expect, it } from 'vitest';
import { criteriaFile, DEFAULT_WASM, Host, proposalsPath } from './host.ts';
import { McpServer, parseLine, PROTOCOL } from './server.ts';

const have = existsSync(DEFAULT_WASM);
if (!have && process.env['CI']) throw new Error('ws_wasm.wasm is missing; run `pnpm build:engine`');

const dir = mkdtempSync(join(tmpdir(), 'ws-mcp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const net = join(dir, 'Net1.inp');
writeFileSync(net, readFileSync(new URL('../../web/public/samples/Net1.inp', import.meta.url)));

let id = 0;
async function call(s: McpServer, method: string, params: Record<string, unknown> = {}) {
  const r = await s.handle({ jsonrpc: '2.0', id: ++id, method, params });
  if (!r) throw new Error('no reply');
  if ('error' in r) return { error: r.error };
  return r.result as Record<string, unknown>;
}
async function tool(s: McpServer, name: string, args: Record<string, unknown> = {}) {
  const r = (await call(s, 'tools/call', { name, arguments: args })) as {
    structuredContent: Record<string, unknown>;
    isError: boolean;
  };
  return r;
}

describe.skipIf(!have)('MCP server', () => {
  it('discovers, lists tools and answers the earlier revisions', async () => {
    const s = new McpServer(await Host.open(net, { accept: false, proposalsFile: null }));
    const d = await call(s, 'server/discover', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL },
    });
    expect(d).toMatchObject({
      resultType: 'complete',
      supportedVersions: [PROTOCOL],
      capabilities: { tools: {} },
    });
    expect(String(d['instructions'])).toContain('Net1.inp');
    const legacy = await call(s, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    expect(legacy).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'waterstudio' } });
    expect(await s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const names = ((await call(s, 'tools/list')) as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['get_project_summary', 'set_properties', 'submit_proposal']),
    );
    expect(names).not.toContain('accept_proposal');
    const bad = await call(s, 'tools/list', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' },
    });
    expect(bad).toMatchObject({ error: { code: -32022 } });
    expect(await call(s, 'nope')).toMatchObject({ error: { code: -32601 } });
    expect(parseLine('{oops')).toMatchObject({ reply: { error: { code: -32700 } } });
  });

  it('lets the agent draft and propose, leaving the network and the file alone', async () => {
    const file = proposalsPath(net);
    const host = await Host.open(net, { accept: false, proposalsFile: file });
    const s = new McpServer(host);
    expect((await tool(s, 'run_analysis')).isError).toBe(false);
    expect((await tool(s, 'set_properties', { links: ['10'], values: { diameter: 20 } })).isError).toBe(
      false,
    );
    const sub = await tool(s, 'submit_proposal', {
      title: 'Larger 10',
      rationale: 'More flow to the network.',
    });
    expect(sub.structuredContent).toMatchObject({ proposal: 'P1', changes: 1 });
    expect(host.store.doc.num(host.store.doc.findLink('10')!, 'diameter')).toBe(18);
    const saved = proposalsFromText(readFileSync(file, 'utf8'));
    expect(saved.network).toBe('Net1.inp');
    expect(saved.proposals[0]).toMatchObject({ id: 'P1', title: 'Larger 10', status: 'pending' });
    expect((await tool(s, 'list_proposals')).structuredContent).toMatchObject({ proposals: [{ id: 'P1' }] });
    const refused = await call(s, 'tools/call', { name: 'accept_proposal', arguments: { id: 'P1' } });
    expect(refused).toMatchObject({ error: { code: -32602 } });
  });

  it('with --accept, applies a proposal and saves a new file', async () => {
    const host = await Host.open(net, { accept: true, proposalsFile: null });
    const s = new McpServer(host);
    await tool(s, 'set_properties', { links: ['10'], values: { diameter: 20 } });
    await tool(s, 'submit_proposal', { title: 'Larger 10', rationale: 'x' });
    expect((await tool(s, 'accept_proposal', { id: 'P1' })).structuredContent).toMatchObject({
      verdict: 'pass',
      applied: 1,
      conflicts: [],
    });
    expect(host.store.doc.num(host.store.doc.findLink('10')!, 'diameter')).toBe(20);
    expect((await tool(s, 'save_network', { path: net })).isError).toBe(true);
    const out = join(dir, 'Net1-sized.inp');
    expect((await tool(s, 'save_network', { path: out })).structuredContent).toMatchObject({ saved: out });
    expect(readFileSync(out, 'utf8')).toMatch(/\n 10\s+10\s+11\s+10530(\.0+)?\s+20(\.0+)?\s/);
  });

  it('checks every proposal against the design criteria and will not accept one that fails', async () => {
    const path = join(dir, 'criteria.json');
    writeFileSync(path, JSON.stringify({ maxVelocity: 3 }));
    const host = await Host.open(net, { accept: true, proposalsFile: null, criteria: criteriaFile(path) });
    const s = new McpServer(host);
    expect((await tool(s, 'get_design_criteria')).structuredContent).toMatchObject({
      maxVelocity: { limit: 3 },
      minPressure: { limit: null },
    });
    await tool(s, 'set_properties', { links: ['10'], values: { diameter: 6 } });
    // Breaking a criterion without saying why is refused at submission.
    expect((await tool(s, 'submit_proposal', { title: 'Narrow 10', rationale: 'x' })).isError).toBe(true);
    const sub = await tool(s, 'submit_proposal', {
      title: 'Narrow 10',
      rationale: 'x',
      unmet: [{ criterion: 'maxVelocity', reason: 'Testing the checker.' }],
    });
    expect(sub.isError).toBe(false);
    const check = await host.checked('P1');
    expect(check.verdict).toBe('fail');
    expect(check.findings.map((f) => f.text).join(' ')).toContain(
      'Maximum velocity (3) was met and now is not',
    );
    expect((await tool(s, 'list_proposals')).structuredContent).toMatchObject({
      proposals: [{ id: 'P1', check: { verdict: 'fail' } }],
    });
    const refused = await tool(s, 'accept_proposal', { id: 'P1' });
    expect(refused.isError).toBe(true);
    expect(host.store.doc.num(host.store.doc.findLink('10')!, 'diameter')).toBe(18);
    expect(host.proposals[0]!.status).toBe('pending');
  });

  it('reads design criteria files strictly', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ maxSpeed: 3 }));
    expect(() => criteriaFile(path)).toThrow(/unknown criterion maxSpeed/);
    writeFileSync(path, JSON.stringify({ minPressure: '20' }));
    expect(() => criteriaFile(path)).toThrow(/minPressure must be a number or null/);
    writeFileSync(path, JSON.stringify({ minPressure: 20, maxPressure: 10 }));
    const inconsistent = criteriaFile(path);
    expect(inconsistent).toMatchObject({ minPressure: 20, maxPressure: 10, maxVelocity: null });
  });

  it('refuses design criteria that cannot be used', async () => {
    const criteria = { ...emptyCriteria(), minPressure: 20, maxPressure: 10 };
    await expect(Host.open(net, { accept: false, proposalsFile: null, criteria })).rejects.toThrow(
      /minimum pressure is above the maximum/,
    );
  });

  it('finds fire flow failures, repairs them and sizes pipes to the criteria in the draft', async () => {
    const path = join(dir, 'sizing.json');
    writeFileSync(path, JSON.stringify({ minPressure: 108, maxVelocity: 2.5, maxHeadloss: 3 }));
    const host = await Host.open(net, { accept: false, proposalsFile: null, criteria: criteriaFile(path) });
    const s = new McpServer(host);
    const sizes = [6, 8, 10, 12, 14, 16, 18, 20, 24].map((diameter, i) => ({
      diameter,
      unit_cost: [50, 60, 75, 90, 110, 130, 150, 170, 210][i]!,
    }));
    const fire = { flow: 2500, residual: 20, system_min: 20 };
    const study = (await tool(s, 'fire_flow_study', fire)).structuredContent;
    expect(study).toMatchObject({ hydrants: 9, fail: 2, failing: ['31', '32'] });
    // Failing first, the least available flow first.
    expect((study['results'] as unknown[]).slice(0, 2)).toMatchObject([
      { id: '32', meets: false, lowestAt: '31' },
      { id: '31', meets: false },
    ]);
    // Repair: the hydrants default to those failing; the sizes found go into the draft.
    expect((await tool(s, 'repair_fire_flow', { ...fire, sizes })).structuredContent).toMatchObject({
      hydrants: ['31', '32'],
      meets: true,
      cost: 950400,
      changes: [
        { pipe: '121', from: 8, to: 12 },
        { pipe: '122', from: 6, to: 12 },
      ],
      applied: true,
      breachesAfter: 0,
      draftChanges: 2,
    });
    const repaired = (await tool(s, 'fire_flow_study', { ...fire, hydrants: ['31', '32'] }))
      .structuredContent;
    expect(repaired).toMatchObject({ fail: 0 });
    await tool(s, 'discard_draft');

    // Sizing to the project's criteria, then submitted: the independent check passes it.
    expect((await tool(s, 'size_pipes', { sizes })).structuredContent).toMatchObject({
      limits: { minPressure: 108, maxVelocity: 2.5, maxHeadloss: 3 },
      meets: true,
      breachesBefore: 4,
      breachesAfter: 0,
      changes: [{ pipe: '111' }, { pipe: '112' }, { pipe: '122' }],
    });
    expect((await tool(s, 'submit_proposal', { title: 'Sized', rationale: 'By size_pipes.' })).isError).toBe(
      false,
    );
    expect((await host.checked('P1')).verdict).toBe('pass');
    expect((await tool(s, 'size_pipes', { sizes, pipes: ['9'] })).isError).toBe(true);
  });
});
