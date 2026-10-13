# ADR 0022: Least-cost pipe sizing and fire-flow repair as one engine study

- Status: accepted
- Date: 2026-10-13

## Context

Phase 4 asks for least-cost pipe sizing and fire-flow repair. Both choose diameters for a set of pipes from a list
of standard sizes so that limits hold, at the least cost; they differ only in the limits: the design criteria over
the whole simulation, or pressures while each hydrant flows. An agent could do this with `set_properties` and
`run_analysis` in a loop, but that costs a model call per trial and gives no assurance of cost. Optimisers in the
literature (genetic algorithms, simulated annealing) find cheaper designs on benchmark networks, but they are
stochastic, slow to converge and hard to explain to the engineer who must sign the design.

## Decision

- **One study, `ws_study::sizing::size_pipes`, in the engine.** It takes the candidate pipes, the sizes with a cost
  per unit length, limits (minimum and maximum junction pressure, maximum pipe velocity and unit head loss, checked
  at every report time) and an optional fire demand (hydrants, flow, residual pressure, system minimum, time of
  day). A pipe kept at its diameter costs nothing; one replaced costs its new size. With `fromSmallest` the pipes
  are sized as new: they start at the smallest size and all are costed.
- **A deterministic greedy search with a trim.** While any limit is broken, the next size up is tried on each
  candidate and the one that removes the most shortfall per unit of added cost is kept; shortfall is the sum over
  breaches of how far past its limit each value is, relative to the limit. Candidates are the pipes that break a
  velocity or head loss limit themselves and the 24 that lose the most head; only if none of those helps is every
  pipe tried. When every limit is met, pipes are stepped back down, largest saving first, while the limits stay
  met. The search is bounded (5,000 solutions by default) and says why it stopped short. This is how an engineer
  sizes by hand, so each change can be explained, and the same input always gives the same design.
- **The app's criteria and the study agree.** Pressures, velocities and head losses are compared as the output
  file stores them (single precision), so a design the study accepts is one `assess` and the independent checker
  (ADR 0021) accept. Fire flow uses the fire flow study's own single-period solve at the time of day.
- **Studies are open to agents.** `AgentHost` and `AgentContext` gain an optional `study`, served by the app's
  engine (with the draft's resident model, ADR 0020) and the MCP server's. Three tools use it:
  `fire_flow_study` (analyse), and `size_pipes` and `repair_fire_flow` (draft), which set the sizes found in the
  draft for the agent to check and submit. `repair_fire_flow` sizes for the hydrants that fail a fire flow study
  unless given others.
- **People get the same study.** The Studies panel has a Pipe sizing tab: pipes (all or selected), design criteria
  and/or fire flow at every junction, sizes and costs, and as new. Its result can be sent to Proposals, through the
  same submission as an agent's (`submitDraft`, which records why any criterion is still broken) and the same
  independent check.
- **Evaluated.** Two costed tasks join the benchmark: `design-sizing` (Net1 to its design criteria) and
  `design-fire` (2,500 gpm at every junction of Net1). A design passes if it meets the limits and costs at most
  10 % more than the best known, which the study found.

## Consequences

- The greedy search is not guaranteed optimal. On Net1 it finds the designs the reference solutions use; on large
  networks a cheaper design may exist. Cost is reported so that a better optimiser (a genetic algorithm seeded with
  the greedy design, say) can be compared against it later without changing the tools or the proposal path.
- Each evaluation is a full extended-period simulation (plus one solve per hydrant for fire flow), on one worker:
  Net1 sizes in about 120 solutions, well under a second. Spreading the trials of a step across the pool is a later
  speed-up; the step's choice depends only on all of its trials, so the result would not change.
- Water quality is not sized for: residual and age criteria are reported by the checker, not met by the study.
- Costs are per unit length of installed pipe and in no particular currency; the defaults the app offers are
  illustrative and must be replaced by the engineer's own.
