# @waterstudio/agent-eval

The agent evaluation (ADR 0019). The tasks, the graders and the baseline are described in
[docs/evals](../../docs/evals/README.md).

```sh
pnpm build:engine                                   # once: the WebAssembly engine
node apps/agent-eval/src/main.ts                    # the reference baseline
node apps/agent-eval/src/main.ts --agent reference --agent null --markdown report.md
WS_EVAL_API_KEY=… node apps/agent-eval/src/main.ts --agent anthropic --model claude-sonnet-5-5 --repeat 3 --out run.json
```

`--agent openai` with `--endpoint` runs any OpenAI-compatible Chat Completions server, including local models.
