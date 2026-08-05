import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compactSession, needsCompaction, planCompaction } from "../src/session/compaction"
import { now, type SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { project } from "../src/session/projector"
import { planPrune } from "../src/session/prune"
import { MockProvider } from "./helpers/mock-provider"

const t = now()

// --- needsCompaction ---

test("does not trigger with plenty of headroom", () => {
  const usage = { input: 50_000, output: 2_000, cacheRead: 0, cacheWrite: 0 }
  expect(needsCompaction(usage, { context: 100_000, output: 16_000 })).toBe(false)
})

test("triggers when the last turn approaches usable context", () => {
  const usage = { input: 80_000, output: 5_000, cacheRead: 0, cacheWrite: 0 }
  expect(needsCompaction(usage, { context: 100_000, output: 16_000 })).toBe(true)
})

// --- planPrune ---

test("prunes old large tool outputs but keeps recent and small ones", () => {
  const events: SessionEvent[] = [
    { type: "session.created", cwd: "/w", time: t },
    { type: "tool.call", callId: "old-large", name: "bash", input: {}, time: t },
    {
      type: "tool.result",
      callId: "old-large",
      output: "x".repeat(10_000),
      isError: false,
      time: t,
    },
    { type: "tool.call", callId: "old-small", name: "bash", input: {}, time: t },
    { type: "tool.result", callId: "old-small", output: "tiny", isError: false, time: t },
    { type: "tool.call", callId: "recent", name: "bash", input: {}, time: t },
    { type: "tool.result", callId: "recent", output: "y".repeat(10_000), isError: false, time: t },
  ]
  const victims = planPrune(events, { windowTokens: 100 })
  expect(victims).toEqual(["old-large"])
})

test("already-pruned outputs are not pruned again", () => {
  const events: SessionEvent[] = [
    { type: "tool.call", callId: "c1", name: "bash", input: {}, time: t },
    { type: "tool.result", callId: "c1", output: "x".repeat(10_000), isError: false, time: t },
    { type: "tool.pruned", callIds: ["c1"], time: t },
    { type: "message.user", id: "u", text: "z".repeat(4_000), time: t },
  ]
  expect(planPrune(events, { windowTokens: 100 })).toEqual([])
})

// --- planCompaction ---

function longSession(): SessionEvent[] {
  return [
    { type: "session.created", cwd: "/w", time: t },
    { type: "message.user", id: "u1", text: `OLD-WORK ${"a".repeat(60_000)}`, time: t },
    { type: "message.assistant", id: "a1", text: "old reply", time: t },
    { type: "message.user", id: "u2", text: "RECENT-ASK", time: t },
    { type: "message.assistant", id: "a2", text: "recent reply", time: t },
  ]
}

test("plans a cut at the oldest boundary whose tail fits the keep budget", () => {
  const plan = planCompaction(longSession(), { keepTokens: 1_000 })
  expect(plan).not.toBeNull()
  // Boundary 2 (the old assistant reply) is the oldest tail that fits — the
  // 60k-char user turn before it gets summarized.
  expect(plan?.keepFromIndex).toBe(2)
  expect(plan?.cutRendered).toContain("OLD-WORK")
  expect(plan?.cutRendered).not.toContain("RECENT-ASK")
})

test("returns null when everything already fits", () => {
  expect(planCompaction(longSession(), { keepTokens: 999_999 })).toBeNull()
})

// --- compactSession ---

test("compactSession journals the summary and the projector folds it", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-compact-")))
  for (const event of longSession()) journal.append(event)

  const provider = new MockProvider([
    [
      { type: "text-delta", text: "## Objective\n- finish the old work" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])

  const result = await compactSession({ provider, model: "small", journal, keepTokens: 1_000 })
  expect(result?.summary).toContain("Objective")

  const { header, events } = SessionJournal.replay(journal.path)
  const state = project(header, events)
  const texts = state.timeline.map((e) => ("text" in e ? e.text : "")).join("\n")
  expect(texts).not.toContain("OLD-WORK")
  expect(texts).toContain("RECENT-ASK")
})
