import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { TurnEvent } from "../src/provider/port"
import { SessionJournal } from "../src/session/journal"
import { runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { sumSpend } from "../src/tool/tools/task"
import { MockProvider } from "./helpers/mock-provider"

const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })
const PRICE = { input: 1, output: 1 } // $1 per 1M tokens either way

/** A stand-in for the task tool: reports its subagents' spend in meta. */
function delegatingRegistry(spend: unknown) {
  const registry = new ToolRegistry()
  registry.register({
    name: "task",
    description: "t",
    inputSchema: z.object({ task: z.string() }),
    execute: async () => ({ output: "subagent summary", meta: { spend } }),
  })
  return registry
}
const callTask = (id: string): TurnEvent[] => [
  { type: "tool-call", callId: id, name: "task", input: { task: "look" } },
  { type: "finish", reason: "tool-calls", usage: usage(10, 10) },
]
const say = (text: string): TurnEvent[] => [
  { type: "text-delta", text },
  { type: "finish", reason: "stop", usage: usage(10, 10) },
]

function deps(provider: MockProvider, registry: ToolRegistry, extra: object = {}) {
  return {
    provider,
    registry,
    journal: SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-spend-"))),
    rules: { "*": "allow" as const },
    model: "m",
    system: "s",
    cwd: "/w",
    cost: PRICE,
    ...extra,
  }
}

test("subagent spend from meta.spend joins the turn's cost and delegated usage", async () => {
  const registry = delegatingRegistry({ usage: usage(400_000, 100_000), costUSD: 0.05 })
  const outcome = await runUserTurn(
    deps(new MockProvider([callTask("t1"), say("ok")]), registry),
    "go",
  )
  expect(outcome.usage).toEqual(usage(20, 20)) // main model only
  expect(outcome.delegatedUsage).toEqual(usage(400_000, 100_000))
  expect(outcome.costUSD).toBeCloseTo(0.05 + 40 / 1_000_000, 8)
})

test("unpriced subagent spend is charged at the main model's rate (conservative)", async () => {
  const registry = delegatingRegistry({ usage: usage(500_000, 500_000) })
  const outcome = await runUserTurn(
    deps(new MockProvider([callTask("t1"), say("ok")]), registry),
    "go",
  )
  expect(outcome.costUSD).toBeCloseTo(1 + 40 / 1_000_000, 8)
})

test("the dollar cap stops a turn whose subagents blew through it", async () => {
  const registry = delegatingRegistry({ usage: usage(1, 1), costUSD: 2 })
  const provider = new MockProvider([callTask("t1"), callTask("t2"), say("never reached")])
  const outcome = await runUserTurn(deps(provider, registry, { maxSpendUSD: 1 }), "go")
  expect(outcome.budgetExceeded).toBe(true)
  expect(provider.requests.length).toBe(2)
})

test("the token budget counts delegated tokens too", async () => {
  const registry = delegatingRegistry({ usage: usage(5_000, 5_000) })
  const provider = new MockProvider([callTask("t1"), callTask("t2"), say("never reached")])
  const outcome = await runUserTurn(deps(provider, registry, { budgetTokens: 1_000 }), "go")
  expect(outcome.budgetExceeded).toBe(true)
  expect(provider.requests.length).toBe(2)
})

test("sumSpend adds usage and prices only when every part is priced", () => {
  expect(sumSpend([undefined])).toBeUndefined()
  expect(
    sumSpend([
      { usage: usage(1, 2), costUSD: 0.1 },
      { usage: usage(3, 4), costUSD: 0.2 },
    ]),
  ).toEqual({
    usage: usage(4, 6),
    costUSD: expect.closeTo(0.3, 8),
  })
  expect(sumSpend([{ usage: usage(1, 2), costUSD: 0.1 }, { usage: usage(3, 4) }])).toEqual({
    usage: usage(4, 6),
  })
})

test("compaction summarizer tokens are delegated spend", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-spend-")))
  const t = new Date().toISOString()
  journal.append({ type: "message.user", id: "u0", text: `old ${"x".repeat(6_000)}`, time: t })
  journal.append({ type: "message.assistant", id: "a0", text: "done before", time: t })
  const overflow: TurnEvent[] = [
    { type: "error", message: "too long", info: { kind: "context_length", message: "too long" } },
  ]
  const summary: TurnEvent[] = [
    { type: "text-delta", text: "## Objective\n- x" },
    { type: "finish", reason: "stop", usage: usage(3_000, 200) },
  ]
  const outcome = await runUserTurn(
    {
      ...deps(new MockProvider([overflow, summary, say("ok")]), new ToolRegistry()),
      journal,
      compactKeepTokens: 100,
      retries: 0,
    },
    "go",
  )
  expect(outcome.delegatedUsage).toEqual(usage(3_000, 200))
})
