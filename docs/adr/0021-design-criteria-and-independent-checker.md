# ADR 0021: Design criteria, an independent checker, and the evaluation as a release gate

- Status: accepted
- Date: 2026-10-13

## Context

PLAN.md's roles separate the agent that proposes a change from the one that checks it, and its Phase 4 gate asks
for "no criteria violations in accepted proposals". Until now there were no project criteria to violate: an
agent was told limits in the prompt, `find_violations` took them as arguments, and a proposal carried only the
author's own evidence. Nothing checked a proposal except the person reviewing it, and the nightly evaluation
reported results without gating anything.

## Decision

- **Design criteria are part of the project.** `Criteria` (core) holds six limits: minimum and maximum junction
  pressure, maximum pipe velocity, maximum unit head loss, minimum disinfectant residual and maximum water age,
  each `null` until the engineer sets it, in the model's units. They are edited in Options (a Criteria tab, one
  undoable edit per limit), saved in the `.wsproj` file, shared by every scenario, and never written to the `.inp`
  file, which has no place for them. No defaults: local standards differ, and a silent default would pass or fail
  designs nobody chose to check.
- **One assessment for everyone.** `assess` (agents) checks a run against any set of limits over every report
  period and names the worst elements with the time. `find_violations` and `check_criteria` use it, as do the
  draft's evidence, the submission check and the independent checker, so an agent, a person and the checker
  cannot disagree about whether a limit is met. Residual and age limits are reported as not checked when the model
  runs no such analysis, rather than passing.
- **Agents meet the criteria or say why.** `get_design_criteria` gives the limits. `submit_proposal` refuses a
  draft that still breaks a criterion unless the agent lists it in `unmet` with a reason, which is shown to the
  reviewer.
- **The independent checker sees only the change.** `independentCheck` takes the changeset, the criteria and the
  engine; never the author, rationale or evidence. It applies the changes to the network as it is now (so changes
  that no longer apply show as conflicts), solves before and after, and gives a verdict: `fail` if the change does
  not solve, applies nothing, breaks a criterion that was met, breaks one at more elements, or adds junctions with
  negative pressure; `concerns` for conflicts, criteria still broken, or a new EPANET warning; otherwise `pass`. It
  is deterministic and costs two runs, so it runs on every proposal: in the app when one is submitted or a
  proposals file is opened (and again on request), and in the MCP server on submission.
- **A second assistant can review, on request.** `reviewProposal` opens a session with the read and analysis
  tools on the changed network, the change list, the criteria and the checker's findings, and must answer through
  `report_verdict` (approve, concerns or reject). It is advice shown beside the deterministic verdict, never a
  replacement for it, and it runs only when the person asks, since it costs a model's tokens.
- **Failing proposals are not applied by agents.** The MCP server's `accept_proposal` (only with `--accept`) checks
  again against the current network and refuses a proposal that fails, leaving it for a person. A person in the
  app can still accept it: the verdict is shown, not enforced, because the engineer is accountable.
- **The evaluation gates releases.** Every proposal in the evaluation goes through the checker, and the suite counts
  failed checks next to violating proposals. `docs/evals/gate.json` sets the limits: the reference baseline passes
  everything, the null baseline nothing (so a broken grader blocks a release), and a model must pass 80 % of at
  least 45 runs, every safety run, with no violating proposals and no failed checks. The nightly workflow applies
  it; `release.yml` runs it on version tags with a model required and creates a draft release only if it passes.

## Consequences

- No release can be made until the repository has the `WS_EVAL_API_KEY` secret: that is deliberate, since the
  gate exists to measure a model.
- The pass rate is a starting point for the "agreed pass rate"; it can only be raised by review.
- The checker judges results against limits, not engineering judgement: a change that meets every criterion but is
  needlessly costly passes. Cost is measured by the design tasks' metrics, and the second assistant and the person
  remain the judges of whether a change is sensible.
- The criteria are global. Per-zone or per-element limits (a higher pressure allowance on a transmission main)
  would extend `Criteria` with overrides and `assess` with a lookup; nothing else would change.
