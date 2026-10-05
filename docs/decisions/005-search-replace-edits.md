# 005: Search/replace edits with a syntax gate

Status: accepted

## Context

Edit format has a large effect on how reliably models change code. Whole-file
rewrites are expensive and lossy on long files; unified diffs are easy for
models to get subtly wrong.

## Options

1. Whole-file writes.
2. Unified diffs.
3. Search/replace blocks, with whole-file writes for new files.

## Decision

Option 3. The `edit` tool takes an exact `old_string` and its replacement. The
engine:

- preserves the file's line endings;
- tolerates indentation drift and re-indents the replacement to match;
- on a miss, quotes the closest region of the file so the model can retry
  precisely;
- rejects a TypeScript/JavaScript edit that would leave the file unparseable, before writing.

## Consequences

- Malformed-edit rate is a tracked metric (`butterfly bench`).
- Failed edits stay in the conversation as error-correction signal.
