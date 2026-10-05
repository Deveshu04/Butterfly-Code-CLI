# What Butterfly writes to disk

Butterfly writes only to three places:

- the project's `.butterfly/` folder (add it to your `.gitignore`, except
  `PROJECT.md` if you want to share project memory),
- `~/.config/butterfly/` for global config, user memory and caches,
- one `butterfly/` folder in the OS temp directory for short-lived files.

Nothing is written per keypress, and launching the TUI writes nothing until
there is something to save (the session journal is created with its first
event).

## Project folder: `.butterfly/`

| Path | What | When it is written |
|---|---|---|
| `sessions/*.jsonl` | Session journals (append-only) | One line per event |
| `PROJECT.md` | Project memory (capped) | When memory is updated |
| `skills/` | Learned and hand-written skills | When a skill is drafted or promoted |
| `commands/` | Your custom slash commands | Only by you |
| `graph.db`, `project-map.md` | Code graph and its readable summary | Only when code changed |
| `index.db` | Full-text index of past sessions | After a turn |
| `undo-index` + git objects | Checkpoints for `/undo` and `/rewind` | Before each mutating tool call |
| `worktrees/` | Isolated checkouts for parallel subagents | Removed on merge or discard |
| `bg/` | Logs of background shell tasks | While tasks run |
| `queue.db`, `loop.jsonl`, `handoff.json` | Autonomous loop state | Per loop iteration |
| `media/` | Pasted images | When you attach one |

Every `.db` file is derived and can be deleted; it is rebuilt from the
journals or the source tree.

## User folder: `~/.config/butterfly/`

| Path | What |
|---|---|
| `butterfly.jsonc` | Global config (API keys may live here; keep it private) |
| `USER.md` | User memory (capped) |
| `commands/`, `themes/` | Your global commands and themes |
| `models-cache.json` | Model catalog cache, refreshed at most once a day |

The standalone binary also extracts its bundled assets (grammars, ripgrep)
once per version into `~/.cache/butterfly/assets/<version>/`.

## Temp folder

`<temp>/butterfly/` holds the transcript pager export (one file per session,
overwritten) and `butterfly bench` fixtures (deleted after scoring unless you
pass `--keep`).

## Tests

The test suite redirects the OS temp directory to one per-run folder
(`scripts/test-sandbox.ts`) and deletes it afterwards, so running the tests
leaves nothing behind.
