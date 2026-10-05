# Design decisions

Short records of the choices that shape Butterfly Code: the context, the
options that were considered, what was chosen, and the consequences.

| # | Decision |
|---|---|
| [001](001-runtime-and-ui-stack.md) | TypeScript on Bun, with an OpenTUI + SolidJS terminal UI |
| [002](002-provider-port.md) | One narrow provider port, implemented over the Vercel AI SDK |
| [003](003-journal-source-of-truth.md) | Append-only JSONL journals are the source of truth; SQLite is derived |
| [004](004-small-tool-set.md) | A small, fixed tool set with `op` dispatch |
| [005](005-search-replace-edits.md) | Search/replace edits with a syntax gate |
| [006](006-cache-shaped-context.md) | Cache-shaped context: frozen prefix, append-only transcript, prune before compaction |
| [007](007-permission-tree.md) | A permission tree instead of an OS sandbox |
| [008](008-readonly-bash-auto-approval.md) | Provably read-only shell commands skip a blanket "ask" |
| [009](009-memory-design.md) | Capped memory files, on-demand recall and verified skills |
| [010](010-code-graph.md) | A local tree-sitter + SQLite code graph with PageRank |
| [011](011-loop-supervisor.md) | Autonomous loops run by a supervisor with no model of its own |
| [012](012-subagents-as-a-tool.md) | Subagents are a tool, not a mode |
| [013](013-multi-pane-tui.md) | Multi-pane terminal layout |
