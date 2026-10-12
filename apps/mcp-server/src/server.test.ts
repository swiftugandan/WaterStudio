import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposalsFromText } from '@waterstudio/agents';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_WASM, Host, proposalsPath } from './host.ts';
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
      applied: 1,
      conflicts: [],
    });
    expect(host.store.doc.num(host.store.doc.findLink('10')!, 'diameter')).toBe(20);
    expect((await tool(s, 'save_network', { path: net })).isError).toBe(true);
    const out = join(dir, 'Net1-sized.inp');
    expect((await tool(s, 'save_network', { path: out })).structuredContent).toMatchObject({ saved: out });
    expect(readFileSync(out, 'utf8')).toMatch(/\n 10\s+10\s+11\s+10530(\.0+)?\s+20(\.0+)?\s/);
  });
});
