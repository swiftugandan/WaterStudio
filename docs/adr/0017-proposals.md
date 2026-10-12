# ADR 0017: Agents edit drafts and hand back changesets a person accepts

- Status: accepted
- Date: 2026-10-12

## Context

ADR 0011 gave agents read-only tools and reserved editing for proposals. The plan's rule is that nothing an agent
does reaches the engineer's model without review, undo and attribution, and that the engine, not the model,
supplies the evidence. Edits include structural ones (new junctions and pipes, deletions), which the scenario
manager's property overrides (ADR 0013) cannot express, and the engineer keeps working while an agent drafts.

## Decision

- **Drafts.** A session that may propose (the assistant's default; it can be set to read only) works on a
  `Sandbox`: two copies of the live document made by `Document.clone`, which keeps handles. The agent edits one
  copy through the same core edit functions people use; the other is what it started from. Read tools and
  `run_analysis` look at the draft, so the agent can iterate with the engine. Draft tools (`set_properties`,
  `add_nodes`, `add_links`, `delete_elements`, `get_draft_changes`, `discard_draft`) have scope `draft`;
  `submit_proposal` has scope `propose`. A registry call outside those scopes is refused.
- **Changesets name elements by ID.** `diffDocuments(base, draft)` compares the two copies by handle and writes
  adds, field changes (each with the value it replaces), deletions and replaced document-level data (patterns,
  curves, controls, options...). Link ends are node IDs, compared by node so a rename does not move links.
- **Evidence from the engine.** On submission the host runs the base and the draft and attaches key figures
  (lowest and highest junction pressure, junctions with negative pressure, highest pipe velocity, demand, EPANET's
  warning) with any run error. The draft then starts again from the live model.
- **Review.** Proposals queue in the app (cleared when another network opens). The Proposals panel shows the
  rationale, the figures before and after, and each change with its old and new value in the model's units; the
  engineer can show the affected elements on the map, untick changes, then accept (one undoable transaction
  labelled with the proposal), reject, or send it back with a comment, which goes to the agent's conversation.
- **Conflicts.** `applyChangeset` applies the chosen items in a safe order (nodes, links, values, renames, link
  deletions, node deletions, document data). An item whose element no longer holds the value it replaces, or
  that would collide or dangle, is skipped and reported; the rest apply.
- **Hosts.** `AgentHost` (the live document, run and files of any document, a submit function, an author) is all
  a draft session needs. The app is one host; `apps/mcp-server` is the other: a Node CLI over the same registry
  and the WebAssembly engine, speaking MCP's stateless 2026-07-28 revision on stdio (and `initialize` for earlier
  clients). Headless proposals go to a file beside the network (lossless JSON, `proposalsToText`) that the
  Proposals panel opens; only when the server is started with `--accept` may the agent apply proposals itself and
  save the network to a new file.

## Consequences

- An agent can design (add, resize, close, delete) without any path to the live model except a person's accept,
  and every accepted proposal is one undo step attributed to its session.
- The map does not yet draw a proposal's added, removed and modified elements in their own colours; Show on map
  selects the existing elements it touches. A design-criteria profile, an independent checker role and
  auto-apply for named drafts are Phase 4.
- Tool names and schemas of the draft tools are now an interface, like the read tools.
