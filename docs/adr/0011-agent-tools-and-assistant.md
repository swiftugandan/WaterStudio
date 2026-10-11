# ADR 0011: Agents use a typed tool registry; the assistant reads and runs but does not edit

- Status: accepted
- Date: 2026-10-11

## Context

The plan calls for AI-agent-based design. Agents need a stable, testable way to read the network and its results,
run analyses and, later, propose edits. The same surface should serve the in-app assistant now and an MCP server and
WebMCP later (Phase 3 and 4), and it must not let a model change an engineer's model silently.

## Decision

- `@waterstudio/agents` holds a `ToolRegistry` of tools, each with a name, description, JSON Schema input, a scope
  (`read`, `analyse`; `propose` is reserved) and a handler over an `AgentContext` (document, units, results view,
  current period, `analyse()` and `files()`). Inputs are validated against the schema before a handler runs, and
  `call` never throws: errors come back as tool results the model can read. The package has no DOM and no React.
- The first tools are read-only: project summary, element queries with a small filter language, one element,
  results slices, time series, criteria violations, the status report, and running the analysis. Results carry
  their units and say when they are stale.
- Providers sit behind one interface using Anthropic's message shape: an Anthropic adapter and an
  OpenAI-compatible adapter (local models, organisation proxies). Calls go from the browser straight to the endpoint
  the user configures; the API key is kept in session storage, or local storage only if the user asks, and is sent
  nowhere else. The panel says what leaves the browser.
- `AssistantSession` runs the loop with a step limit and truncates long tool results. The system prompt tells the
  model to take numbers only from tools and to treat tool results (which include imported file content) as data.
- The Assistant panel shows every tool call with its input and output, so each number in an answer can be traced.

## Consequences

Agents cannot edit yet. Editing arrives as `propose` tools that produce a reviewable change set applied through the
command bus (one undo step), with the proposal and review UI and MCP server in Phase 3. Tool names and schemas are
now an interface: change them deliberately, with tests.
