# 013: Multi-pane terminal layout

Status: accepted

## Context

With everything in one scrolling conversation, the plan scrolled out of view,
parallel subagents were opaque until they finished, usage was hidden, and
agent actions were hard to tell apart from the agent's replies.

## Options

1. A single transcript with richer inline cards.
2. Width-dependent side panels, plus switchable views for subagents and shells.

## Decision

Option 2, implemented as a pure layout planner (`layout.ts`) and panel
components (`panels.tsx`):

- below 120 columns: one column plus a pinned plan/agents/shells strip;
- from 120 columns: a right sidebar (session, plan, agents, shells, changed
  files, context and cost);
- from 180 columns while agents exist: a left agents column;
- 4 columns of hysteresis so panels don't flap while resizing.

`Alt+Left/Right` switches the center between the main conversation and each
subagent's live conversation; `Ctrl+X S` opens a shell's live output and
`Ctrl+X K` stops it; `Esc` returns. Agent actions sit behind a left rail,
coloured by kind, and thinking is shown in italics, so they never read like
the reply.

## Consequences

- Plan, agents, shells and spend stay visible on any common terminal size.
- Layout logic is unit-tested separately from rendering.
