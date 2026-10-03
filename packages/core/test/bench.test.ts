import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractSessionMetrics } from "../src/bench/metrics"
import { runBenchSuite } from "../src/bench/run"
import { now } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { ToolRegistry } from "../src/tool/registry"
import { editTool } from "../src/tool/tools/edit"
import { MockProvider, zeroUsage } from "./helpers/mock-provider"

const usage = { input: 2_000, output: 150, cacheRead: 500, cacheWrite: 0 }

test("metrics count turns, tool calls, and malformed edits from the journal", () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-metrics-")))
  const t = now()
  journal.append({ type: "message.user", id: "u", text: "task", time: t })
  journal.append({ type: "message.assistant", id: "a1", text: "", time: t })
  journal.append({ type: "tool.call", callId: "c1", name: "edit", input: {}, time: t })
  journal.append({
    type: "tool.result",
    callId: "c1",
    output: "Edit rejected (not_found): …",
    isError: true,
    time: t,
  })
  journal.append({ type: "tool.call", callId: "c2", name: "edit", input: {}, time: t })
  journal.append({ type: "tool.result", callId: "c2", output: "Edited x", isError: false, time: t })
  journal.append({ type: "tool.call", callId: "c3", name: "bash", input: {}, time: t })
  journal.append({ type: "tool.result", callId: "c3", output: "boom", isError: true, time: t })
  journal.append({ type: "turn.completed", model: "m", usage, time: t })

  const metrics = extractSessionMetrics(journal.path)
  expect(metrics.turns).toBe(1)
  expect(metrics.usage.input).toBe(2_000)
  expect(metrics.toolCalls).toBe(3)
  expect(metrics.toolErrors).toBe(2)
  expect(metrics.editCalls).toBe(2)
  expect(metrics.malformedEdits).toBe(1)
})

test("bench suite runs tasks in fixtures, checks them, and aggregates", async () => {
  // Scripted agent: solves task one (writes the file via edit), flubs task two.
  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "e1",
        name: "edit",
        input: { file_path: "OUT.txt", old_string: "", new_string: "expected-content\n" },
      },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "created it" },
      { type: "finish", reason: "stop", usage },
    ],
    [
      { type: "text-delta", text: "i give up" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const makeRegistry = () => {
    const registry = new ToolRegistry()
    registry.register(editTool)
    return registry
  }

  const summary = await runBenchSuite(
    [
      { id: "solvable", task: "write OUT.txt", check: "grep -q expected-content OUT.txt" },
      { id: "unsolvable", task: "do nothing", check: "test -f NEVER.txt" },
    ],
    {
      provider,
      makeRegistry,
      model: "mock",
      buildSystem: () => "bench system",
      keepFixtures: true,
    },
  )

  expect(summary.total).toBe(2)
  expect(summary.solved).toBe(1)
  expect(summary.results[0]?.solved).toBe(true)
  expect(summary.results[1]?.solved).toBe(false)
  expect(summary.totalInputTokens).toBe(6_000)
  expect(summary.inputTokensPerSolved).toBe(6_000)
  const written = readFileSync(join(summary.results[0]?.fixtureDir ?? "", "OUT.txt"), "utf8")
  expect(written).toBe("expected-content\n")
}, 60_000)

test("bench deletes each fixture after scoring unless keepFixtures is set", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ])
  const summary = await runBenchSuite([{ id: "t/1", task: "nothing", check: "true" }], {
    provider,
    makeRegistry: () => new ToolRegistry(),
    model: "mock",
    buildSystem: () => "s",
  })
  const result = summary.results[0]
  expect(result?.kept).toBe(false)
  expect(existsSync(result?.fixtureDir ?? "")).toBe(false)
  // Fixtures never sit loose in temp: they live under <temp>/butterfly/bench.
  expect(result?.fixtureDir.replaceAll("\\", "/")).toContain("/butterfly/bench/t_1-")
})
