import { expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { type HookRunRecord, hookMatches, runHooks } from "../src/session/hooks"
import { SessionJournal } from "../src/session/journal"
import { runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"

function dir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-hooks-"))
}

test("hookMatches filters by event and tool wildcard", () => {
  const hook = { event: "pre.tool" as const, match: "edit*", command: "true" }
  expect(hookMatches(hook, "pre.tool", "edit")).toBe(true)
  expect(hookMatches(hook, "pre.tool", "bash")).toBe(false)
  expect(hookMatches(hook, "post.tool", "edit")).toBe(false)
  expect(hookMatches({ event: "turn.end", command: "true" }, "turn.end")).toBe(true)
})

test("hooks run with event context in the environment", async () => {
  const cwd = dir()
  const result = await runHooks(
    [{ event: "turn.end", command: 'echo "$BUTTERFLY_EVENT:$BUTTERFLY_TOOL" > hook-ran.txt' }],
    "turn.end",
    { cwd, tool: "none" },
  )
  expect(result.ran).toBe(1)
  expect(result.blocked).toBe(false)
  expect(existsSync(join(cwd, "hook-ran.txt"))).toBe(true)
}, 30_000)

test("a failing pre.tool hook blocks with its output as the reason", async () => {
  const result = await runHooks(
    [{ event: "pre.tool", match: "*", command: 'echo "edits are frozen on fridays" && exit 1' }],
    "pre.tool",
    { cwd: dir(), tool: "edit" },
  )
  expect(result.blocked).toBe(true)
  expect(result.reason).toContain("frozen on fridays")
}, 30_000)

test("feedback hooks surface failing check output", async () => {
  const result = await runHooks(
    [
      {
        event: "post.tool",
        match: "edit",
        command: 'echo "src/app.ts(3,1): TS2304 name not found" && exit 2',
        feedback: true,
      },
    ],
    "post.tool",
    { cwd: dir(), tool: "edit" },
  )
  expect(result.feedback).toContain("TS2304")
  expect(result.feedback).toContain("exit 2")
}, 30_000)

test("the runner feeds failing post-edit checks back to the model", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "edit", input: { text: "x" } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    [
      { type: "text-delta", text: "fixing" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const registry = new ToolRegistry()
  registry.register({
    name: "edit",
    description: "Pretend edit.",
    inputSchema: z.object({ text: z.string() }),
    execute: async () => ({ output: "Edited ok" }),
  })
  const journal = SessionJournal.create(dir())
  await runUserTurn(
    {
      provider,
      registry,
      journal,
      rules: { "*": "allow" },
      model: "m",
      system: "s",
      cwd: dir(),
      hooks: [
        {
          event: "post.tool",
          match: "edit",
          command: 'echo "typecheck FAILED" && exit 1',
          feedback: true,
        },
      ],
    },
    "edit something",
  )
  const { events } = SessionJournal.replay(journal.path)
  const result = events.find((e) => e.type === "tool.result")
  const output = result && "output" in result ? result.output : ""
  expect(output).toContain("Edited ok")
  expect(output).toContain("typecheck FAILED")
  expect(result && "isError" in result ? result.isError : false).toBe(true)
  // The same failing feedback hook also gets a hook.run record.
  const run = events.find((e) => e.type === "hook.run")
  expect(run && "feedback" in run ? run.feedback : false).toBe(true)
  expect(run && "exitCode" in run ? run.exitCode : -1).toBe(1)
}, 40_000)

test("the runner denies tool calls that a pre.tool hook blocks", async () => {
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "echo", input: { text: "hi" } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    [
      { type: "text-delta", text: "understood" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  let executions = 0
  const registry = new ToolRegistry()
  registry.register({
    name: "echo",
    description: "Echoes.",
    inputSchema: z.object({ text: z.string() }),
    execute: async (input) => {
      executions += 1
      return { output: input.text }
    },
  })
  const journal = SessionJournal.create(dir())
  await runUserTurn(
    {
      provider,
      registry,
      journal,
      rules: { "*": "allow" },
      model: "m",
      system: "s",
      cwd: dir(),
      hooks: [{ event: "pre.tool", match: "echo", command: "exit 1" }],
    },
    "try the tool",
  )
  expect(executions).toBe(0)
  const { events } = SessionJournal.replay(journal.path)
  const result = events.find((e) => e.type === "tool.result")
  expect(result && "isError" in result ? result.isError : false).toBe(true)
  expect(result && "output" in result ? result.output : "").toContain("hook")
  // The blocking pre.tool hook also gets a hook.run record.
  const run = events.find((e) => e.type === "hook.run")
  expect(run && "blocked" in run ? run.blocked : false).toBe(true)
}, 40_000)

// hook observability (journal `hook.run` events)

test("runHooks reports a run record via onRun for a passing hook", async () => {
  const runs: HookRunRecord[] = []
  const result = await runHooks(
    [{ event: "turn.end", command: "true" }],
    "turn.end",
    { cwd: dir() },
    { onRun: (run) => runs.push(run) },
  )
  expect(result.ran).toBe(1)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({
    event: "turn.end",
    command: "true",
    exitCode: 0,
    blocked: false,
    feedback: false,
  })
  expect(runs[0]?.durationMs).toBeGreaterThanOrEqual(0)
}, 30_000)

test("runHooks reports a failing hook that neither blocks nor gives feedback", async () => {
  const runs: HookRunRecord[] = []
  await runHooks(
    [{ event: "turn.end", command: "exit 3" }],
    "turn.end",
    { cwd: dir() },
    {
      onRun: (run) => runs.push(run),
    },
  )
  expect(runs[0]).toMatchObject({ exitCode: 3, blocked: false, feedback: false })
}, 30_000)

test("runHooks reports blocked:true for a blocking pre.tool hook run", async () => {
  const runs: HookRunRecord[] = []
  const result = await runHooks(
    [{ event: "pre.tool", match: "*", command: "exit 1" }],
    "pre.tool",
    { cwd: dir(), tool: "edit" },
    { onRun: (run) => runs.push(run) },
  )
  expect(result.blocked).toBe(true)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({ blocked: true, exitCode: 1 })
}, 30_000)

test("runHooks reports feedback:true for a failing feedback post.tool hook run", async () => {
  const runs: HookRunRecord[] = []
  await runHooks(
    [{ event: "post.tool", match: "edit", command: 'echo "bad" && exit 2', feedback: true }],
    "post.tool",
    { cwd: dir(), tool: "edit" },
    { onRun: (run) => runs.push(run) },
  )
  expect(runs[0]).toMatchObject({ feedback: true, exitCode: 2 })
  expect(runs[0]?.outputHead).toContain("bad")
}, 30_000)

test("outputHead is capped even when the hook prints a lot", async () => {
  const runs: HookRunRecord[] = []
  await runHooks(
    [{ event: "turn.end", command: 'printf "%01000d" 7' }],
    "turn.end",
    { cwd: dir() },
    { onRun: (run) => runs.push(run) },
  )
  expect(runs[0]?.outputHead.length).toBeLessThanOrEqual(500)
}, 30_000)

test("enabled:false hooks are skipped entirely — no run, no onRun call", async () => {
  const runs: HookRunRecord[] = []
  const result = await runHooks(
    [{ event: "turn.end", command: "true", enabled: false }],
    "turn.end",
    { cwd: dir() },
    { onRun: (run) => runs.push(run) },
  )
  expect(result.ran).toBe(0)
  expect(runs).toHaveLength(0)
}, 30_000)

test("the runner journals hook.run for turn.start and turn.end hooks", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "done" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const registry = new ToolRegistry()
  const journal = SessionJournal.create(dir())
  await runUserTurn(
    {
      provider,
      registry,
      journal,
      rules: { "*": "allow" },
      model: "m",
      system: "s",
      cwd: dir(),
      hooks: [
        { event: "turn.start", command: "true" },
        { event: "turn.end", command: "exit 1" },
      ],
    },
    "hello",
  )
  const { events } = SessionJournal.replay(journal.path)
  const runs = events.filter((e) => e.type === "hook.run")
  expect(runs).toHaveLength(2)
  const turnStart = runs.find((e) => "event" in e && e.event === "turn.start")
  const turnEnd = runs.find((e) => "event" in e && e.event === "turn.end")
  expect(turnStart && "exitCode" in turnStart ? turnStart.exitCode : -1).toBe(0)
  expect(turnEnd && "exitCode" in turnEnd ? turnEnd.exitCode : -1).toBe(1)
}, 40_000)

test("enabled:false hooks never produce a hook.run journal event via the runner", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "done" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const registry = new ToolRegistry()
  const journal = SessionJournal.create(dir())
  await runUserTurn(
    {
      provider,
      registry,
      journal,
      rules: { "*": "allow" },
      model: "m",
      system: "s",
      cwd: dir(),
      hooks: [{ event: "turn.start", command: "true", enabled: false }],
    },
    "hello",
  )
  const { events } = SessionJournal.replay(journal.path)
  expect(events.some((e) => e.type === "hook.run")).toBe(false)
}, 40_000)
