# WaterStudio MCP server

`ws-mcp` lets an MCP client (Claude Code, an IDE, another agent) work on a water network headlessly, with the same
tools as WaterStudio's assistant and the same engine, which reproduces OWA-EPANET 2.3 exactly.

```sh
pnpm build:engine                      # once: builds the WebAssembly engine
node apps/mcp-server/src/main.ts network.inp
# or, in Claude Code:
claude mcp add waterstudio -- node /path/to/WaterStudio/apps/mcp-server/src/main.ts /path/to/network.inp
```

It speaks the stateless 2026-07-28 revision of the protocol on stdio (`server/discover`, version and client details
in each request's `_meta`) and still answers `initialize` for clients of the 2024-11-05 to 2025-11-25 revisions.
Node 22.18 or later runs it directly from the TypeScript sources.

## What the agent can do

- Read: project summary, element queries (`pressure < 20 and type = junction`), one element, results slices, time
  series, design-limit violations, the status report, the proposals so far.
- Analyse: run the hydraulic and water-quality simulation.
- Draft: set properties, add nodes and links, delete elements, review and discard its draft. The draft is a private
  copy of the network; the read tools look at it.
- Propose: `submit_proposal` diffs the draft against the network and attaches the engine's results before and after.

## Who applies a change

By default, nobody but the engineer: proposals are written to `network.proposals.json` (or the file given with
`--proposals FILE`; `--no-proposals-file` keeps them in memory). Open that file in WaterStudio's Proposals panel to
review the changes and accept all or some of them.

With `--accept`, the agent may also `accept_proposal` and `save_network` to a new `.inp` file (never over the one it
opened). `.wsproj` projects open read-only: the agent proposes, the engineer accepts in WaterStudio.
