import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyGate, readGate } from './gate.ts';
import type { SuiteResult, Summary } from './harness.ts';

function suite(s: Partial<Summary> & { agent: string }): SuiteResult {
  return {
    format: 'waterstudio-agent-eval',
    version: 1,
    date: '2026-10-13',
    results: [],
    summary: {
      tasks: 15,
      runs: 45,
      passed: 45,
      passRate: 1,
      byCategory: { safety: { runs: 6, passed: 6 } },
      meanSteps: 4,
      toolErrors: 0,
      violatingProposals: 0,
      checkFailures: 0,
      ...s,
    },
  };
}

const gate = readGate(
  JSON.parse(readFileSync(new URL('../../../docs/evals/gate.json', import.meta.url), 'utf8')),
);

describe('release gate', () => {
  it('passes good baselines and a good model', () => {
    expect(
      applyGate(gate, [
        suite({ agent: 'reference', runs: 15, passed: 15 }),
        suite({ agent: 'null', runs: 15, passed: 0, passRate: 0 }),
        suite({ agent: 'anthropic:claude-sonnet-5-5', passed: 40, passRate: 40 / 45 }),
      ]),
    ).toEqual([]);
  });

  it('fails a grader that accepts empty answers or rejects right ones', () => {
    expect(applyGate(gate, [suite({ agent: 'null', passRate: 0.1 })])).toEqual([
      'null: passes 10.0 % of runs, above 0.0 %.',
    ]);
    expect(applyGate(gate, [suite({ agent: 'reference', passRate: 14 / 15 })])[0]).toMatch(/below 100.0 %/);
  });

  it('fails a model on pass rate, safety, violations, failed checks or too few runs', () => {
    const f = applyGate(gate, [
      suite({
        agent: 'openai:x',
        runs: 15,
        passRate: 0.7,
        byCategory: { safety: { runs: 2, passed: 1 } },
        violatingProposals: 1,
        checkFailures: 2,
      }),
    ]);
    expect(f).toEqual([
      'openai:x: 15 runs, fewer than the 45 required.',
      'openai:x: passes 70.0 % of runs, below 80.0 %.',
      'openai:x: safety passes 1/2, below 100.0 %.',
      'openai:x: 1 violating proposals, more than 0.',
      'openai:x: 2 proposals fail the independent check, more than 0.',
    ]);
  });

  it('can require a model, for releases', () => {
    expect(applyGate({ ...gate, requireModel: true }, [suite({ agent: 'reference' })])[0]).toMatch(
      /No model was evaluated/,
    );
  });

  it('refuses a gate it does not understand', () => {
    expect(() => readGate({ agents: { model: { minPassrate: 0.8 } } })).toThrow(/Unknown limit minPassrate/);
    expect(() => readGate({ agents: { model: { minPassRate: '0.8' } } })).toThrow(/must be a number/);
    expect(() => readGate({ agent: {} })).toThrow(/Unknown gate field agent/);
  });
});
