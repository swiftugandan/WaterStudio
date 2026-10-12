# ADR 0019: Agents are evaluated on fixed tasks with graders that ask the engine

- Status: accepted
- Date: 2026-10-12

## Context

The plan calls for a benchmark of design and analysis tasks with deterministic graders, run nightly for each
model. Phase 3's gate needs a baseline recorded, and Phase 4's gate needs a pass rate with no criteria violations
in accepted proposals. A grader that is itself a model would be neither deterministic nor trustworthy. Expected
answers written into the tasks would go out of date whenever a network or the engine changed.

## Decision

- **The real path.** `apps/agent-eval` runs each task through `AssistantSession`, with the read and draft
  tools, on the MCP server's `Host` (the WebAssembly engine on a loaded `.inp`). The scopes are the ones the app
  gives a read-only or proposing assistant. Nothing is mocked except the model.
- **Graders ask the engine.** Each task's grader computes its expected values at grading time, from the network
  and an engine run. Answers are checked for those numbers (to 0.5 %, or exactly for counts) and element IDs.
  Proposals are checked by applying them to a copy of the network with `applyChangeset` and running the engine
  on the result. A design or edit proposal that fails its checks is a violating proposal.
- **Every task has a reference solution:** a scripted agent that uses only the tools a model gets. Reference
  14/14 and null 0/14 are unit tests. The tests also check that each grader rejects plausible wrong work.
- **Results** are JSON (`waterstudio-agent-eval`, version 1) and a Markdown table by category, with mean model
  calls, tool errors and violating proposals. A model's key is read from `WS_EVAL_API_KEY` and sent only to the
  configured endpoint. The nightly workflow runs a model only when that secret exists.

## Consequences

- The baseline in `docs/evals` records the harness (reference and null). The first model baseline is recorded
  when a run has a key. Until then the Phase 3 gate's "baseline recorded" covers the benchmark, not a model's
  score.
- Number matching can be fooled by an answer that lists many numbers. The tasks ask for one or two values, and
  the floor and wrong-work tests guard the graders. A model that games this would show up in the transcripts the
  results keep.
- The set is small (14 tasks, three networks). Phase 4 adds tasks for layout, sizing, calibration and fire-flow
  repair, and makes the nightly pass rate a release gate.
