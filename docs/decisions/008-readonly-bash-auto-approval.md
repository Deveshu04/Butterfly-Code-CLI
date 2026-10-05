# 008: Provably read-only shell commands skip a blanket "ask"

Status: accepted

## Context

With the interactive default `bash: "ask"`, harmless commands such as `ls`,
`git status` or `rg foo | head` prompt as loudly as destructive ones. Frequent
prompts train people to approve without reading, which is a safety failure.

## Options

1. Keep asking for everything.
2. Let a model judge whether a command is safe.
3. Prove read-only-ness statically with a strict parser and allowlist.

## Decision

Option 3. A tool may declare `autoAllow(input)`. The registry honours it only
when the decision is `ask`, the decision came from a blanket rule (the tool's
plain entry, its `"*"` pattern or the root default), and
`autoApproveReadOnly` is not disabled. Explicit user patterns and every `deny`
still win.

A shell command qualifies only if it:

- tokenizes without `$`, backticks, redirections, subshells, braces,
  background `&`, escapes or newlines;
- is simple commands joined by `|`, `||`, `&&` or `;`;
- uses only allowlisted commands, each with argument checks (no
  `find -exec/-delete`, `rg --pre`, `sort -o`, `git -c` or `--output`; read-only
  git subcommands only);
- names no `.env` file.

Anything the parser does not understand asks as before.

## Consequences

- Most investigation commands stop prompting, so the remaining prompts mean
  something.
- A false negative costs one prompt; a false positive would be a security
  bug. The allowlist stays small and every entry needs tests.
