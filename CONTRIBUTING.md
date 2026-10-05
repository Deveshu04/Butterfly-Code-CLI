# Contributing to Butterfly Code

Thanks for your interest! Bug reports, fixes, docs and features are all welcome.

## Ground rules

- **Discuss big changes first.** Open an issue before starting a large feature
  or a refactor, so we can agree on the approach.
- **Keep pull requests focused.** One logical change per PR, with tests.
- **Original work only.** Do not paste code from other projects, including other
  coding agents, unless its license is compatible with Apache-2.0 *and* the PR
  clearly says where it came from. When in doubt, ask in the issue first.
- Be kind. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
instead of a CLA. By adding a `Signed-off-by` line to each commit you certify
that you wrote the change, or otherwise have the right to submit it under the
project's license (Apache-2.0).

Sign off with `git commit -s`, which appends:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email must match the commit author. A CI check rejects pull
requests that contain commits without a sign-off. To fix a branch:

```sh
git rebase --signoff main   # signs off every commit on your branch
git push --force-with-lease
```

## Development setup

Requirements: [Bun](https://bun.sh) 1.3 or newer and git.

```sh
git clone https://github.com/Deveshu04/Butterfly-Code-CLI.git
cd Butterfly-Code-CLI
bun install
bun packages/cli/src/index.ts          # run the TUI from source
```

Before pushing:

```sh
bun run typecheck
bun run lint
bun test
```

All three must pass; CI runs them on Linux, macOS and Windows.

## Project layout

```
packages/core   engine: sessions, context, providers, tools, edits, permissions,
                code graph, memory, loops
packages/tui    terminal UI (OpenTUI + SolidJS)
packages/cli    the `butterfly` command
docs/           architecture and design decisions
scripts/        build, release and test helpers
```

Read [docs/architecture.md](docs/architecture.md) before changing the core.

## Conventions

- TypeScript strict mode, ESM only, `zod` for runtime validation.
- Formatting and linting with Biome (`bun run format`).
- Tests live in `packages/*/test/` and use `bun:test`. Tests must not write
  outside the per-run temp sandbox (`scripts/test-sandbox.ts`).
- Comments explain *why*, not *what*. Keep them short.
- The model-visible tool set is deliberately small (12 tools). New
  capabilities should extend an existing tool's `op` parameter instead of
  adding a tool. Discuss first if you think a new tool is needed.
- Session journals are append-only and must stay backward compatible: old
  journals have to keep replaying.
- Significant design decisions get a short record in `docs/decisions/`.

## Commit messages

Use a short imperative subject (max ~72 characters), optionally prefixed with
the area: `tui: show live shell output`, `core: retry dropped streams`. Add a
body when the reason isn't obvious.

## Reporting bugs

Open an issue with the version (`butterfly --version`), OS and terminal, the
provider/model, what you did, what you expected and what happened. For
security issues, see [SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
