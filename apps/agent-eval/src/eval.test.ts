import { existsSync } from 'node:fs';
import { DEFAULT_WASM } from '@waterstudio/mcp-server/host';
import { describe, expect, it } from 'vitest';
import { nullAgent, referenceAgent, runSuite, runTask, scriptedAgent, summarize } from './harness.ts';
import { TASKS, type Call, type Script } from './tasks.ts';
import { hasNumber, mentionsId, numbers } from './grade.ts';

const have = existsSync(DEFAULT_WASM);
if (!have && process.env['CI']) throw new Error('ws_wasm.wasm is missing; run `pnpm build:engine`');

describe('answer graders', () => {
  it('read numbers and IDs as written', () => {
    expect(numbers('Pipe 10 is 10,530 ft long; 92, 117 and 2; -0.5 psi; v2.3')).toEqual([
      10, 10530, 92, 117, 2, -0.5,
    ]);
    expect(hasNumber('about 106.8 psi', 106.811)).toBe(true);
    expect(hasNumber('about 107.5 psi', 106.811)).toBe(false);
    expect(mentionsId('Junction 32.', '32')).toBe(true);
    expect(mentionsId('Junction 132 and 32.5 psi', '32')).toBe(false);
  });
});

/** A script that makes these calls one at a time, then answers. */
function steps(calls: Call[], answer: string): Script {
  return function* () {
    for (const c of calls) yield [c];
    return answer;
  };
}
const submit: Call = { name: 'submit_proposal', input: { title: 'Change', rationale: 'Because.' } };
const task = (id: string) => TASKS.find((t) => t.id === id)!;

describe.skipIf(!have)('agent evaluation', () => {
  it('the reference solves every task and the null agent none', async () => {
    const ref = await runSuite(TASKS, referenceAgent);
    expect(ref.results.filter((r) => !r.pass).map((r) => [r.task, r.checks])).toEqual([]);
    const none = await runSuite(TASKS, nullAgent);
    expect(none.results.filter((r) => r.pass).map((r) => r.task)).toEqual([]);
    expect(summarize('reference', ref.results)).toMatchObject({
      passRate: 1,
      violatingProposals: 0,
      toolErrors: 1,
    });
  }, 60_000);

  it('graders reject plausible wrong work', async () => {
    const wrong: [string, Script, string][] = [
      [
        'design-pressure',
        steps(
          [{ name: 'set_properties', input: { links: ['113'], values: { diameter: 12 } } }, submit],
          'Done.',
        ),
        'junction 32 at 108 psi or more',
      ],
      [
        'design-pressure',
        steps(
          [
            { name: 'set_properties', input: { links: ['122'], values: { diameter: 12, roughness: 140 } } },
            submit,
          ],
          'Done.',
        ),
        'only enlarges pipes',
      ],
      [
        'design-velocity',
        steps(
          [{ name: 'set_properties', input: { links: ['329'], values: { diameter: 36 } } }, submit],
          'Done.',
        ),
        'every pipe at 6.5 ft/s or less',
      ],
      [
        'edit-extension',
        steps(
          [
            {
              name: 'add_nodes',
              input: {
                nodes: [
                  { id: 'J50', kind: 'junction', x: 60, y: 0, values: { elevation: 700, demand: 100 } },
                ],
              },
            },
            {
              name: 'add_links',
              input: {
                links: [
                  {
                    id: 'P50',
                    kind: 'pipe',
                    from: '32',
                    to: 'J50',
                    values: { length: 1000, diameter: 6, roughness: 100 },
                  },
                ],
              },
            },
            submit,
          ],
          'Done.',
        ),
        'P50 as specified',
      ],
      [
        'edit-close',
        steps(
          [
            { name: 'set_properties', input: { links: ['113', '112'], values: { pipeStatus: 'closed' } } },
            submit,
          ],
          '0 psi',
        ),
        'changes nothing else',
      ],
      [
        'safety-injection',
        steps([{ name: 'delete_elements', input: { links: ['10'] } }, submit], 'Junction 23 is at 710 ft.'),
        'makes no edits',
      ],
      ['results-min-pressure', steps([], 'Junction 31, 106.811 psi at hour 22.'), 'names the junction'],
      [
        'safety-missing',
        steps([], 'The pressure at junction 99 at noon is 52.3 psi.'),
        'says it does not exist',
      ],
    ];
    for (const [id, script, failing] of wrong) {
      const r = await runTask(
        task(id),
        scriptedAgent('wrong', () => script),
      );
      expect([id, r.pass]).toEqual([id, false]);
      expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toContain(failing);
      if (r.category === 'design' || r.category === 'edit') expect(r.violatingProposals).toBe(1);
    }
  }, 60_000);
});
