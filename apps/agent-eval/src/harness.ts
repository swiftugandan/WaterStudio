/**
 * Runs tasks through the same assistant loop, tools, drafts and proposals the app uses,
 * on the headless host the MCP server uses, then grades them.
 */

import {
  AssistantSession,
  DRAFT_TOOLS,
  READ_TOOLS,
  ToolRegistry,
  providerFor,
  systemPrompt,
  type Block,
  type Completion,
  type Provider,
  type ProviderSettings,
  type Scope,
} from '@waterstudio/agents';
import { fileURLToPath } from 'node:url';
import { Host } from '@waterstudio/mcp-server/host';
import { grading, type Check, type ToolCall, type Transcript } from './grade.ts';
import type { Call, Category, Network, Script, Task } from './tasks.ts';

export const RESULTS_FORMAT = 'waterstudio-agent-eval';

/** Who answers: a model behind a provider, or a scripted baseline. */
export interface Agent {
  name: string;
  provider(task: Task): Provider;
}

/** An agent that follows a script per task, through the real loop and tools. */
export function scriptedAgent(name: string, scriptFor: (task: Task) => Script): Agent {
  return { name, provider: (task) => scripted(scriptFor(task)) };
}

/** The reference baseline: each task's scripted solution. */
export const referenceAgent: Agent = scriptedAgent('reference', (t) => t.reference);

/** The floor: answers without looking anything up. Every task must fail it. */
export const nullAgent: Agent = {
  name: 'null',
  provider: () => ({
    complete: () =>
      Promise.resolve({
        content: [{ type: 'text', text: 'I cannot tell from here; please check the model.' }],
        stopReason: 'end_turn',
      }),
  }),
};

export function modelAgent(settings: ProviderSettings): Agent {
  return { name: `${settings.kind}:${settings.model}`, provider: () => providerFor(settings) };
}

function scripted(script: Script): Provider {
  const gen = script();
  let seq = 0;
  let started = false;
  return {
    complete(req): Promise<Completion> {
      let step: IteratorResult<Call[], string>;
      if (!started) {
        started = true;
        step = gen.next([]);
      } else {
        const last = req.messages.at(-1);
        const results = (last?.content ?? []).flatMap((b) => {
          if (b.type !== 'tool_result') return [];
          if (b.is_error) return [{ error: b.content }];
          try {
            return [JSON.parse(b.content) as unknown];
          } catch {
            return [{ error: b.content }];
          }
        });
        step = gen.next(results);
      }
      if (step.done) {
        return Promise.resolve({ content: [{ type: 'text', text: step.value }], stopReason: 'end_turn' });
      }
      const content: Block[] = step.value.map((c) => ({
        type: 'tool_use',
        id: `ref_${++seq}`,
        name: c.name,
        input: c.input,
      }));
      return Promise.resolve({ content, stopReason: 'tool_use' });
    },
  };
}

const NETWORKS: Record<Network, URL> = {
  Net1: new URL('../../web/public/samples/Net1.inp', import.meta.url),
  Net2: new URL('../../web/public/samples/Net2.inp', import.meta.url),
  Net3: new URL('../../web/public/samples/Net3.inp', import.meta.url),
};

export interface TaskResult {
  task: string;
  category: Category;
  network: Network;
  run: number;
  pass: boolean;
  checks: Check[];
  steps: number;
  toolCalls: number;
  toolErrors: number;
  ms: number;
  metrics: Record<string, number>;
  /** Proposals whose engine results break the task's criteria (design and edit tasks). */
  violatingProposals: number;
  error: string | null;
  answer: string;
}

export interface RunOptions {
  wasm?: Uint8Array;
  maxSteps?: number;
  timeoutMs?: number;
}

export async function runTask(task: Task, agent: Agent, run = 1, opts: RunOptions = {}): Promise<TaskResult> {
  const host = await Host.open(fileURLToPath(NETWORKS[task.network]), {
    accept: false,
    proposalsFile: null,
    ...(opts.wasm ? { wasm: opts.wasm } : {}),
  });
  if (task.setup) {
    task.setup(host);
    host.ctx.reset();
  }
  const propose = task.mode === 'propose';
  const scopes: Scope[] = propose ? ['read', 'analyse', 'draft', 'propose'] : ['read', 'analyse'];
  const registry = new ToolRegistry([...READ_TOOLS, ...(propose ? DRAFT_TOOLS : [])]);
  const inner = agent.provider(task);
  let steps = 0;
  const provider: Provider = {
    complete: (req) => {
      steps++;
      return inner.complete(req);
    },
  };
  const session = new AssistantSession(provider, registry, host.ctx, {
    system: systemPrompt(propose),
    scopes,
    maxSteps: opts.maxSteps ?? 20,
    maxTokens: 4096,
  });
  const texts: string[] = [];
  const calls = new Map<string, ToolCall>();
  let error: string | null = null;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 300_000);
  const t0 = performance.now();
  await session.send(
    task.prompt,
    (e) => {
      if (e.kind === 'text') texts.push(e.text);
      else if (e.kind === 'tool') calls.set(e.id, { name: e.name, input: e.input, ok: true, content: '' });
      else if (e.kind === 'tool-result') {
        const c = calls.get(e.id);
        if (c) Object.assign(c, { ok: e.ok, content: e.content });
      } else error = e.message;
    },
    signal,
  );
  if (signal.aborted) error ??= 'timed out';
  const t: Transcript = {
    answer: texts.join('\n'),
    toolCalls: [...calls.values()],
    steps,
    error,
    proposals: host.proposals,
    ms: Math.round(performance.now() - t0),
  };
  let checks: Check[];
  let metrics: Record<string, number> = {};
  try {
    const o = await task.grade(grading(host, t));
    checks = o.checks;
    metrics = o.metrics ?? {};
  } catch (e) {
    checks = [{ name: 'grader ran', pass: false, detail: e instanceof Error ? e.message : String(e) }];
  }
  const pass = checks.length > 0 && checks.every((c) => c.pass);
  const judged = task.category === 'design' || task.category === 'edit';
  return {
    task: task.id,
    category: task.category,
    network: task.network,
    run,
    pass,
    checks,
    steps: t.steps,
    toolCalls: t.toolCalls.length,
    toolErrors: t.toolCalls.filter((c) => !c.ok).length,
    ms: t.ms,
    metrics,
    violatingProposals: judged && !pass ? t.proposals.length : 0,
    error: t.error,
    answer: t.answer.length > 4000 ? `${t.answer.slice(0, 4000)}…` : t.answer,
  };
}

export interface Summary {
  agent: string;
  tasks: number;
  runs: number;
  passed: number;
  passRate: number;
  byCategory: Record<string, { runs: number; passed: number }>;
  meanSteps: number;
  toolErrors: number;
  violatingProposals: number;
}

export function summarize(agent: string, results: TaskResult[]): Summary {
  const byCategory: Summary['byCategory'] = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { runs: 0, passed: 0 });
    c.runs++;
    if (r.pass) c.passed++;
  }
  const passed = results.filter((r) => r.pass).length;
  return {
    agent,
    tasks: new Set(results.map((r) => r.task)).size,
    runs: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    byCategory,
    meanSteps: results.length ? results.reduce((a, r) => a + r.steps, 0) / results.length : 0,
    toolErrors: results.reduce((a, r) => a + r.toolErrors, 0),
    violatingProposals: results.reduce((a, r) => a + r.violatingProposals, 0),
  };
}

export interface SuiteResult {
  format: typeof RESULTS_FORMAT;
  version: 1;
  date: string;
  summary: Summary;
  results: TaskResult[];
}

export async function runSuite(
  tasks: readonly Task[],
  agent: Agent,
  opts: RunOptions & { repeat?: number; onResult?: (r: TaskResult) => void } = {},
): Promise<SuiteResult> {
  const results: TaskResult[] = [];
  for (let run = 1; run <= (opts.repeat ?? 1); run++) {
    for (const task of tasks) {
      const r = await runTask(task, agent, run, opts);
      results.push(r);
      opts.onResult?.(r);
    }
  }
  return {
    format: RESULTS_FORMAT,
    version: 1,
    date: new Date().toISOString().slice(0, 10),
    summary: summarize(agent.name, results),
    results,
  };
}

const CATEGORIES: Category[] = ['lookup', 'results', 'diagnosis', 'design', 'edit', 'safety'];

/** A Markdown table of suites side by side, then each task's checks. */
export function markdown(suites: SuiteResult[]): string {
  const pct = (p: number, r: number) => (r ? `${p}/${r}` : '—');
  const lines = [
    `| Agent | Pass | ${CATEGORIES.join(' | ')} | Mean steps | Tool errors | Violating proposals |`,
    `| --- | --- | ${CATEGORIES.map(() => '---').join(' | ')} | --- | --- | --- |`,
  ];
  for (const s of suites) {
    const m = s.summary;
    const cats = CATEGORIES.map((c) => pct(m.byCategory[c]?.passed ?? 0, m.byCategory[c]?.runs ?? 0));
    lines.push(
      `| ${m.agent} (${s.date}) | ${pct(m.passed, m.runs)} | ${cats.join(' | ')} | ${m.meanSteps.toFixed(1)} | ` +
        `${m.toolErrors} | ${m.violatingProposals} |`,
    );
  }
  lines.push('', `| Task | ${suites.map((s) => s.summary.agent).join(' | ')} |`);
  lines.push(`| --- | ${suites.map(() => '---').join(' | ')} |`);
  const ids = [...new Set(suites.flatMap((s) => s.results.map((r) => r.task)))];
  for (const id of ids) {
    const cells = suites.map((s) => {
      const rs = s.results.filter((r) => r.task === id);
      const failed = [...new Set(rs.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => c.name)))];
      const p = rs.filter((r) => r.pass).length;
      return `${p}/${rs.length}${failed.length ? ` (fails: ${failed.join('; ')})` : ''}`;
    });
    lines.push(`| ${id} | ${cells.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}
