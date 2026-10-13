#!/usr/bin/env node
/**
 * `ws-mcp`: WaterStudio's MCP server on stdio. One JSON-RPC message per line in and out;
 * anything else goes to stderr.
 *
 *   ws-mcp network.inp [--accept] [--proposals FILE | --no-proposals-file] [--criteria FILE]
 *
 * --criteria reads design criteria from a JSON file (for example
 * `{"minPressure": 20, "maxVelocity": 2}`, in the network's units) in place of the
 * project's; every proposal is checked against them (ADR 0021).
 * Without --accept the agent can only propose: proposals go to network.proposals.json
 * (or FILE), for review in WaterStudio's Proposals panel.
 */

import { createInterface } from 'node:readline';
import type { Criteria } from '@waterstudio/core';
import { criteriaFile, Host, proposalsPath } from './host.ts';
import { McpServer, parseLine } from './server.ts';

const USAGE =
  'usage: ws-mcp <network.inp|project.wsproj> [--accept] [--proposals FILE | --no-proposals-file] [--criteria FILE]';

async function main(argv: string[]): Promise<number> {
  let file: string | null = null;
  let accept = false;
  let proposals: string | null | undefined;
  let criteria: Criteria | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--accept') accept = true;
    else if (a === '--no-proposals-file') proposals = null;
    else if (a === '--proposals') proposals = argv[++i] ?? null;
    else if (a === '--criteria') {
      const path = argv[++i];
      if (!path) {
        process.stderr.write(`${USAGE}\n`);
        return 2;
      }
      criteria = criteriaFile(path);
    } else if (a === '--help' || a === '-h') {
      process.stderr.write(`${USAGE}\n`);
      return 0;
    } else if (!a.startsWith('-') && file === null) file = a;
    else {
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
  }
  if (!file) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const host = await Host.open(file, {
    accept,
    proposalsFile: proposals === undefined ? proposalsPath(file) : proposals,
    ...(criteria ? { criteria } : {}),
  });
  for (const issue of host.issues.slice(0, 20)) process.stderr.write(`ws-mcp: ${issue}\n`);
  process.stderr.write(
    `ws-mcp: ${host.fileName}, ${host.store.doc.nodes.liveCount} nodes, ${host.store.doc.links.liveCount} links\n`,
  );
  const server = new McpServer(host);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Replies go out in the order requests came in.
  let queue = Promise.resolve();
  for await (const line of rl) {
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      const parsed = parseLine(line);
      const reply = 'reply' in parsed ? parsed.reply : await server.handle(parsed.msg);
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  }
  await queue;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`ws-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
