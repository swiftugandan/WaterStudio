#!/usr/bin/env node
/**
 * ws-eval: run the agent evaluation and write the results.
 *
 *   ws-eval --agent reference --agent null --out results.json --markdown results.md
 *   WS_EVAL_API_KEY=… ws-eval --agent anthropic --model claude-sonnet-5-5 --repeat 3
 *
 * The key is read from WS_EVAL_API_KEY and sent only to the endpoint given.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DEFAULT_SETTINGS, type ProviderSettings } from '@waterstudio/agents';
import {
  markdown,
  modelAgent,
  nullAgent,
  referenceAgent,
  runSuite,
  type Agent,
  type SuiteResult,
} from './harness.ts';
import { applyGate, readGate } from './gate.ts';
import { TASKS } from './tasks.ts';

const USAGE = `Usage: ws-eval [options]
  --agent NAME     reference, null, anthropic or openai (repeatable; default reference)
  --model ID       model for anthropic or openai
  --endpoint URL   Messages or Chat Completions endpoint (default: Anthropic's)
  --tasks REGEX    only tasks whose ID matches
  --repeat N       run every task N times (default 1)
  --out FILE       write the results as JSON
  --markdown FILE  write a Markdown report
  --gate FILE      fail (exit 1) unless the results meet the gate (docs/evals/gate.json)
  --require-model  with --gate: fail unless a model was evaluated (for releases)
The API key is read from WS_EVAL_API_KEY.`;

const { values } = parseArgs({
  options: {
    agent: { type: 'string', multiple: true },
    model: { type: 'string' },
    endpoint: { type: 'string' },
    tasks: { type: 'string' },
    repeat: { type: 'string' },
    out: { type: 'string' },
    markdown: { type: 'string' },
    gate: { type: 'string' },
    'require-model': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function agentFor(name: string): Agent {
  if (name === 'reference') return referenceAgent;
  if (name === 'null') return nullAgent;
  if (name !== 'anthropic' && name !== 'openai') throw new Error(`Unknown agent ${name}.\n${USAGE}`);
  if (!values.model) throw new Error(`--agent ${name} needs --model.`);
  const key = process.env['WS_EVAL_API_KEY'];
  const settings: ProviderSettings = {
    kind: name,
    model: values.model,
    endpoint:
      values.endpoint ??
      (name === 'anthropic' ? DEFAULT_SETTINGS.endpoint : 'https://api.openai.com/v1/chat/completions'),
    ...(key ? { apiKey: key } : {}),
  };
  return modelAgent(settings);
}

// Read the gate first, so a bad gate file fails before an expensive run.
const gate = values.gate ? readGate(JSON.parse(readFileSync(values.gate, 'utf8'))) : null;
if (gate && values['require-model']) gate.requireModel = true;
if (values['require-model'] && !gate) throw new Error('--require-model needs --gate.');

const pattern = values.tasks ? new RegExp(values.tasks) : null;
const tasks = TASKS.filter((t) => !pattern || pattern.test(t.id));
const repeat = Number(values.repeat ?? 1);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat takes a whole number of 1 or more.');

const suites: SuiteResult[] = [];
for (const name of values.agent ?? ['reference']) {
  const agent = agentFor(name);
  const suite = await runSuite(tasks, agent, {
    repeat,
    onResult: (r) => {
      const failed = r.checks.filter((c) => !c.pass).map((c) => c.name + (c.detail ? ` (${c.detail})` : ''));
      console.error(
        `${r.pass ? 'pass' : 'FAIL'}  ${agent.name}  ${r.task}#${r.run}  ${r.steps} steps, ${r.toolCalls} tools, ` +
          `${r.ms} ms${failed.length ? `  ${failed.join('; ')}` : ''}${r.error ? `  [${r.error}]` : ''}`,
      );
    },
  });
  const s = suite.summary;
  console.error(`${agent.name}: ${s.passed}/${s.runs} passed (${(100 * s.passRate).toFixed(0)} %)`);
  suites.push(suite);
}
if (values.out)
  writeFileSync(values.out, `${JSON.stringify(suites.length === 1 ? suites[0] : suites, null, 2)}\n`);
if (values.markdown) writeFileSync(values.markdown, markdown(suites));
if (gate) {
  const failures = applyGate(gate, suites);
  for (const f of failures) console.error(`GATE  ${f}`);
  console.error(failures.length ? `The gate fails (${failures.length}).` : 'The gate passes.');
  if (failures.length) process.exitCode = 1;
}
