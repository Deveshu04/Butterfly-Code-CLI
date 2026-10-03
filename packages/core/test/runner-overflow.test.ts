import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TurnEvent } from "../src/provider/port"
import { SessionJournal } from "../src/session/journal"
import { type RunnerEvent, runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider, zeroUsage } from "./helpers/mock-provider"

const overflow: TurnEvent[] = [
  {
    type: "error",
    message: "context too long",
    info: { kind: "context_length", message: "maximum context length exceeded" },
  },
]
const say = (text: string): TurnEvent[] => [
  { type: "text-delta", text },
  { type: "finish", reason: "stop", usage: zeroUsage },
]

function seededJournal(): SessionJournal {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-overflow-")))
  const t = new Date().toISOString()
  journal.append({ type: "message.user", id: "u0", text: `old work ${"x".repeat(6_000)}`, time: t })
  journal.append({ type: "message.assistant", id: "a0", text: "did old work", time: t })
  return journal
}

function run(journal: SessionJournal, provider: MockProvider, events: RunnerEvent[]) {
  return runUserTurn(
    {
      provider,
      registry: new ToolRegistry(),
      journal,
      rules: { "*": "allow" },
      model: "m",
      system: "sys",
      cwd: "/w",
      compactKeepTokens: 100,
      retries: 0,
      onEvent: (event) => events.push(event),
    },
    "next task",
  )
}

test("a context-length rejection compacts once and re-runs the step on the smaller transcript", async () => {
  const journal = seededJournal()
  // step attempt 1 → overflow; compaction summarizer; step attempt 2 → ok
  const provider = new MockProvider([overflow, say("## Objective\n- old work"), say("all good")])
  const events: RunnerEvent[] = []
  const outcome = await run(journal, provider, events)
  expect(outcome.text).toBe("all good")
  expect(
    events.some(
      (e) => e.type === "notice" && e.text.includes("compacted the transcript, retrying"),
    ),
  ).toBe(true)
  expect(events.some((e) => e.type === "step-retracted")).toBe(true)
  const replayed = SessionJournal.replay(journal.path).events
  expect(replayed.some((e) => e.type === "session.compacted")).toBe(true)
  // The retried request carried the summary, not the 6k-char original.
  const lastRequest = provider.requests.at(-1)
  const text = JSON.stringify(lastRequest?.messages)
  expect(text).toContain("Summary of earlier work")
  expect(text).not.toContain("x".repeat(6_000))
})

test("a second overflow in the same turn fails instead of looping", async () => {
  const journal = seededJournal()
  const provider = new MockProvider([overflow, say("## Objective\n- s"), overflow])
  await expect(run(journal, provider, [])).rejects.toThrow("Provider error")
})
