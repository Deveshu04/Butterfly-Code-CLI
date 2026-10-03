import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { ProviderPort, TurnEvent, TurnRequest } from "../src/provider/port"
import type { ToolContext } from "../src/tool/registry"
import { ToolRegistry } from "../src/tool/registry"
import { runCommand } from "../src/tool/shell"
import { editTool } from "../src/tool/tools/edit"
import { createTaskTool, type TaskToolOptions } from "../src/tool/tools/task"
import { listWorktrees } from "../src/tool/worktree"

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }

/**
 * Parallel subagents consume responses in a nondeterministic order, so this
 * provider ROUTES on the subagent's brief instead of a fixed script, and
 * records peak concurrency + which model each spawn ran on.
 */
class RoutingProvider implements ProviderPort {
  active = 0
  peak = 0
  readonly models: string[] = []
  constructor(
    private route: (brief: string, step: number) => TurnEvent[],
    private delayMs = 80,
  ) {}
  async *streamTurn(request: TurnRequest): AsyncIterable<TurnEvent> {
    this.models.push(request.model)
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    try {
      await new Promise((r) => setTimeout(r, this.delayMs))
      const user = request.messages.find((m) => m.role === "user")
      const brief = typeof user?.content === "string" ? user.content : ""
      const step = request.messages.filter((m) => m.role === "tool").length
      yield* this.route(brief, step)
    } finally {
      this.active -= 1
    }
  }
}

const say = (text: string): TurnEvent[] => [
  { type: "text-delta", text },
  { type: "finish", reason: "stop", usage },
]

async function gitFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bfly-orch-"))
  await runCommand("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  })
  writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
  writeFileSync(join(dir, "b.ts"), "export const b = 1\n")
  writeFileSync(join(dir, ".gitignore"), ".butterfly/\n")
  await runCommand("git add -A && git commit -qm init", { cwd: dir })
  return dir
}

function options(
  dir: string,
  provider: ProviderPort,
  extra: Partial<TaskToolOptions> = {},
): TaskToolOptions {
  return {
    provider: () => provider,
    model: () => "big-model",
    subagentModel: () => "small-model",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-orch-sessions-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => {
      const registry = new ToolRegistry()
      registry.register(editTool)
      return registry
    },
    ...extra,
  }
}

const ctx = (dir: string, extra: Partial<ToolContext> = {}): ToolContext => ({
  cwd: dir,
  rules: { "*": "allow" },
  state: {},
  ...extra,
})

test("tasks=[…] runs subagents IN PARALLEL, each on its tier's model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-orch-ro-"))
  const provider = new RoutingProvider((brief) => say(`findings for: ${brief.split("\n")[0]}`), 120)
  const tool = createTaskTool(options(dir, provider))
  const started = Date.now()
  const result = await tool.execute(
    {
      tasks: [
        { task: "map the auth module" },
        { task: "design the cache invalidation", model: "main" },
        { task: "list every test file" },
      ],
    },
    ctx(dir),
  )
  const elapsed = Date.now() - started
  expect(provider.peak).toBe(3)
  expect(elapsed).toBeLessThan(3 * 120)
  expect(result.output).toContain("3 subagents ran in parallel")
  expect(result.output).toContain("## [1/3] map the auth module")
  expect(result.output).toContain("findings for: design the cache invalidation")
  // Order-independent: the "main" brief ran on the big model, the rest small.
  expect(provider.models.filter((m) => m === "big-model").length).toBe(1)
  expect(provider.models.filter((m) => m === "small-model").length).toBe(2)
  expect(result.output).toMatch(/\(big-model, read-only\)/)
})

test("without a subagent model configured, spawns fall back to the main model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-orch-fallback-"))
  const provider = new RoutingProvider(() => say("ok"), 1)
  const tool = createTaskTool(options(dir, provider, { subagentModel: () => undefined }))
  await tool.execute({ task: "look around" }, ctx(dir))
  expect(provider.models).toEqual(["big-model"])
})

const editStep = (file: string, from: string, to: string): TurnEvent[] => [
  {
    type: "tool-call",
    callId: `e-${file}`,
    name: "edit",
    input: { file_path: file, old_string: from, new_string: to },
  },
  { type: "finish", reason: "tool-calls", usage },
]

test("parallel worktree workers edit independently, then op=merge integrates both", async () => {
  const dir = await gitFixture()
  const provider = new RoutingProvider((brief, step) => {
    const file = brief.includes("bump a") ? "a.ts" : "b.ts"
    const name = file[0]
    return step === 0
      ? editStep(file, `export const ${name} = 1\n`, `export const ${name} = 2\n`)
      : say(`bumped ${file}`)
  })
  const asks: string[] = []
  const tool = createTaskTool(options(dir, provider))
  const batch = await tool.execute(
    {
      tasks: [
        { task: "bump a", isolation: "worktree" },
        { task: "bump b", isolation: "worktree" },
      ],
    },
    ctx(dir, {
      rules: { "*": "allow", edit: "ask", bash: "ask" },
      ask: async (request) => {
        asks.push(request.note ?? "")
        return "allow"
      },
    }),
  )
  // ONE approval for the whole batch, not one per worker.
  expect(asks.length).toBe(1)
  expect(asks[0]).toContain("2 isolated subagents in parallel")
  expect(batch.isError).toBeFalsy()
  // Main tree untouched until merge.
  expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export const a = 1\n")

  const pending = listWorktrees(dir)
  expect(pending.length).toBe(2)
  const listed = await tool.execute({ op: "list" }, ctx(dir))
  expect(listed.output).toContain("1 changed")

  for (const worktree of pending) {
    const merged = await tool.execute({ op: "merge", worktree: worktree.id }, ctx(dir))
    expect(merged.isError).toBeFalsy()
    expect(merged.output).toContain("Merged 1 file(s)")
  }
  expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export const a = 2\n")
  expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("export const b = 2\n")
  expect(listWorktrees(dir)).toEqual([])
  expect((await tool.execute({ op: "list" }, ctx(dir))).output).toContain("No isolated worktrees")
}, 60_000)

test("a conflicting merge changes nothing and keeps the worktree for inspection", async () => {
  const dir = await gitFixture()
  const provider = new RoutingProvider((_, step) =>
    step === 0 ? editStep("a.ts", "export const a = 1\n", "export const a = 2\n") : say("done"),
  )
  const tool = createTaskTool(options(dir, provider))
  const run = await tool.execute({ task: "bump a", isolation: "worktree" }, ctx(dir))
  const id = (run.meta as { worktree: { id: string } }).worktree.id
  // The main tree moved on in the meantime.
  writeFileSync(join(dir, "a.ts"), "export const a = 99\n")
  const merged = await tool.execute({ op: "merge", worktree: id }, ctx(dir))
  expect(merged.isError).toBe(true)
  expect(merged.output).toContain("do not apply cleanly")
  expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export const a = 99\n")
  expect(listWorktrees(dir).map((w) => w.id)).toEqual([id])
  const discarded = await tool.execute({ op: "discard", worktree: id }, ctx(dir))
  expect(discarded.output).toContain("Discarded")
  expect(listWorktrees(dir)).toEqual([])
}, 60_000)

test("merging obeys the edit rule: plan mode refuses, an ask session asks", async () => {
  const dir = await gitFixture()
  const provider = new RoutingProvider((_, step) =>
    step === 0 ? editStep("b.ts", "export const b = 1\n", "export const b = 3\n") : say("done"),
  )
  const tool = createTaskTool(options(dir, provider))
  const run = await tool.execute({ task: "bump b", isolation: "worktree" }, ctx(dir))
  const id = (run.meta as { worktree: { id: string } }).worktree.id

  const plan = await tool.execute(
    { op: "merge", worktree: id },
    ctx(dir, { rules: { "*": "allow", edit: "deny" } }),
  )
  expect(plan.isError).toBe(true)
  expect(plan.output).toContain("refused")

  const declined = await tool.execute(
    { op: "merge", worktree: id },
    ctx(dir, { rules: { "*": "allow", edit: "ask" }, ask: async () => "deny" }),
  )
  expect(declined.isError).toBe(true)
  expect(readFileSync(join(dir, "b.ts"), "utf8")).toBe("export const b = 1\n")
  expect(existsSync(listWorktrees(dir)[0]?.path ?? "")).toBe(true)
}, 60_000)

test("a batch where one subagent throws still returns the others", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-orch-fail-"))
  const provider = new RoutingProvider((brief) => {
    if (brief.includes("explode")) throw new Error("boom")
    return say("fine")
  }, 1)
  const tool = createTaskTool(options(dir, provider))
  const result = await tool.execute({ tasks: [{ task: "explode" }, { task: "be calm" }] }, ctx(dir))
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("(1 failed)")
  expect(result.output).toContain("fine")
})

test("a fan-out streams live per-subtask progress and reports its spend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-orch-progress-"))
  const probeRegistry = () => {
    const registry = new ToolRegistry()
    registry.register({
      name: "probe",
      description: "p",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ output: "probed" }),
    })
    return registry
  }
  const provider = new RoutingProvider((brief, step) =>
    step === 0
      ? [
          { type: "tool-call", callId: `c-${brief.slice(0, 5)}`, name: "probe", input: { q: "x" } },
          { type: "finish", reason: "tool-calls", usage },
        ]
      : say(`done: ${brief.split("\n")[0]}`),
  )
  const tool = createTaskTool(options(dir, provider, { makeRegistry: probeRegistry }))
  const updates: string[] = []
  const result = await tool.execute(
    { tasks: [{ task: "alpha brief" }, { task: "beta brief" }] },
    ctx(dir, { progress: (text) => updates.push(text) }),
  )
  expect(updates.some((u) => u.includes("[1/2] step 1 - probe"))).toBe(true)
  expect(updates.some((u) => u.includes("[2/2] step 1 - probe"))).toBe(true)
  expect(updates.at(-1)).toBe("[1/2] done\n[2/2] done")
  // Two subagents x two provider steps x (10 in + 5 out).
  const spend = (result.meta as { spend?: { usage: typeof usage } }).spend
  expect(spend?.usage).toEqual({ input: 40, output: 20, cacheRead: 0, cacheWrite: 0 })
})

test("subagents report structured live status: queued → running (with journal) → done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-orch-structured-"))
  const provider = new RoutingProvider((brief) => say(`ok: ${brief.split("\n")[0]}`), 20)
  const tool = createTaskTool(options(dir, provider))
  const updates: import("../src/tool/registry").SubagentUpdate[] = []
  await tool.execute(
    { tasks: [{ task: "alpha" }, { task: "beta", model: "main" }] },
    ctx(dir, { subagent: (u) => updates.push(u) }),
  )
  const forAlpha = updates.filter((u) => u.id === "0")
  expect(forAlpha[0]).toMatchObject({
    phase: "queued",
    task: "alpha",
    total: 2,
    model: "small-model",
  })
  expect(forAlpha.some((u) => u.phase === "running" && u.journalPath?.endsWith(".jsonl"))).toBe(
    true,
  )
  expect(forAlpha.at(-1)?.phase).toBe("done")
  expect(updates.filter((u) => u.id === "1").at(-1)).toMatchObject({
    phase: "done",
    model: "big-model",
  })
})

test("a batch larger than the parallel cap runs in waves instead of being rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-orch-waves-"))
  const provider = new RoutingProvider((brief) => say(`ok: ${brief.split("\n")[0]}`), 30)
  const tool = createTaskTool(options(dir, provider))
  const tasks = Array.from({ length: 9 }, (_, i) => ({ task: `part ${i + 1}` }))
  const parsed = tool.inputSchema.safeParse({ tasks })
  expect(parsed.success).toBe(true)
  const result = await tool.execute({ tasks }, ctx(dir))
  expect(result.output).toContain("9 subagents ran in parallel")
  expect(provider.peak).toBeLessThanOrEqual(6)
})
