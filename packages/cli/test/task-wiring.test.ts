import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTaskTool,
  type ProviderPort,
  readTool,
  runCommand,
  type TurnEvent,
  type TurnRequest,
} from "@butterfly/core"
import { taskToolOptions } from "../src/run"

/**
 * Pins the CLI wiring for worktree isolation: the options `runHeadless`
 * builds must give a task tool whose isolation:"worktree" path runs a
 * mutating subagent whose edits land in the worktree, not the main tree.
 */

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }

class MockProvider implements ProviderPort {
  readonly requests: TurnRequest[] = []
  private scripts: TurnEvent[][]
  constructor(scripts: TurnEvent[][]) {
    this.scripts = [...scripts]
  }
  async *streamTurn(request: TurnRequest): AsyncIterable<TurnEvent> {
    this.requests.push(request)
    const script = this.scripts.shift()
    if (!script) throw new Error("MockProvider: no script left for this call")
    for (const event of script) yield event
  }
}

async function gitFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bfly-cli-wt-"))
  await runCommand("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  })
  writeFileSync(join(dir, "app.ts"), "export const v = 1\n")
  await runCommand("git add -A && git commit -qm init", { cwd: dir })
  return dir
}

test("the headless task tool is wired with a mutating registry (read/glob/grep/edit/bash + extras)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-cli-wt-opts-"))
  const opts = taskToolOptions({
    cwd,
    sessionsDir: join(cwd, "sessions"),
    provider: () => new MockProvider([]),
    model: () => "mock/model",
    // Stands in for the real explore/web extras (no zod dep in this package).
    extras: (registry) => registry.register({ ...readTool, name: "explore" }),
  })

  expect(opts.makeMutatingRegistry).toBeDefined()
  const mutating =
    opts
      .makeMutatingRegistry?.()
      .list()
      .map((tool) => tool.name) ?? []
  expect(mutating).toContain("edit")
  expect(mutating).toContain("bash")
  expect(mutating).toContain("read")
  expect(mutating).toContain("explore")
  // The default (read-only) fan-out registry must stay read-only.
  const readOnly = opts
    .makeRegistry()
    .list()
    .map((tool) => tool.name)
  expect(readOnly).not.toContain("edit")
  expect(readOnly).not.toContain("bash")
})

test('a task(isolation:"worktree") through the CLI-shaped options really edits inside the worktree', async () => {
  const cwd = await gitFixture()
  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "s1",
        name: "edit",
        input: {
          file_path: "app.ts",
          old_string: "export const v = 1\n",
          new_string: "export const v = 2\n",
        },
      },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "bumped v to 2" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const tool = createTaskTool(
    taskToolOptions({
      cwd,
      sessionsDir: join(cwd, ".butterfly", "sessions"),
      provider: () => provider,
      model: () => "mock/model",
      extras: () => {},
    }),
  )

  const result = await tool.execute(
    { task: "bump v to 2", isolation: "worktree" },
    { cwd, rules: { "*": "allow" }, state: {} },
  )

  expect(result.isError).toBeFalsy()
  const meta = result.meta as { worktree: { path: string; dirty: boolean } }
  expect(meta.worktree.dirty).toBe(true)
  expect(existsSync(meta.worktree.path)).toBe(true)
  expect(readFileSync(join(meta.worktree.path, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 2\n",
  )
  // The main working tree is untouched.
  expect(readFileSync(join(cwd, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 1\n",
  )
}, 30_000)
