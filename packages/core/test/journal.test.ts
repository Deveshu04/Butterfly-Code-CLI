import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { now, type SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { PRUNED_PLACEHOLDER, project } from "../src/session/projector"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "bfly-journal-"))
}

const t = now()

test("create + append + replay round-trips events", () => {
  const journal = SessionJournal.create(tempDir())
  const events: SessionEvent[] = [
    { type: "session.created", cwd: "D:\\repo", time: t },
    { type: "message.user", id: "u1", text: "hello", time: t },
    { type: "message.assistant", id: "a1", text: "hi there", time: t },
  ]
  for (const e of events) journal.append(e)

  const replayed = SessionJournal.replay(journal.path)
  expect(replayed.header.sessionId).toBe(journal.header.sessionId)
  expect(replayed.events).toEqual(events)
})

test("open resumes an existing journal for appending", () => {
  const journal = SessionJournal.create(tempDir())
  journal.append({ type: "message.user", id: "u1", text: "first", time: t })

  const reopened = SessionJournal.open(journal.path)
  reopened.append({ type: "message.user", id: "u2", text: "second", time: t })

  const replayed = SessionJournal.replay(journal.path)
  expect(replayed.events.length).toBe(2)
})

test("replay rejects a file without a valid header", () => {
  const dir = tempDir()
  const bad = join(dir, "bad.jsonl")
  require("node:fs").writeFileSync(bad, '{"not":"a header"}\n')
  expect(() => SessionJournal.replay(bad)).toThrow(/header/i)
})

test("replay reports the line number of a corrupt event", () => {
  const journal = SessionJournal.create(tempDir())
  journal.append({ type: "message.user", id: "u1", text: "ok", time: t })
  require("node:fs").appendFileSync(journal.path, "{garbage\n")
  expect(() => SessionJournal.replay(journal.path)).toThrow(/line 3/)
})

test("projector accumulates usage across turns", () => {
  const journal = SessionJournal.create(tempDir())
  const usage1 = { input: 100, output: 20, cacheRead: 0, cacheWrite: 50 }
  const usage2 = { input: 200, output: 30, cacheRead: 120, cacheWrite: 0 }
  journal.append({ type: "session.created", cwd: "/w", time: t })
  journal.append({ type: "turn.completed", model: "m1", usage: usage1, time: t })
  journal.append({ type: "turn.completed", model: "m1", usage: usage2, time: t })

  const { header, events } = SessionJournal.replay(journal.path)
  const state = project(header, events)
  expect(state.turns).toBe(2)
  expect(state.usage).toEqual({ input: 300, output: 50, cacheRead: 120, cacheWrite: 50 })
  expect(state.cwd).toBe("/w")
})

test("projector folds compaction: summary replaces the cut prefix", () => {
  const events: SessionEvent[] = [
    { type: "session.created", cwd: "/w", time: t },
    { type: "message.user", id: "u1", text: "old work", time: t },
    { type: "message.assistant", id: "a1", text: "old reply", time: t },
    { type: "message.user", id: "u2", text: "recent", time: t },
    { type: "session.compacted", summary: "did old work", keepFromIndex: 3, time: t },
  ]
  const header = { v: 1 as const, kind: "butterfly-session" as const, sessionId: "s", createdAt: t }
  const state = project(header, events)

  const texts = state.timeline.map((e) => ("text" in e ? e.text : e.type))
  expect(texts).not.toContain("old work")
  expect(texts).toContain("recent")
  expect(state.timeline.some((e) => e.type === "session.compacted")).toBe(true)
})

test("projector redacts pruned tool outputs in place", () => {
  const events: SessionEvent[] = [
    { type: "session.created", cwd: "/w", time: t },
    { type: "tool.call", callId: "c1", name: "bash", input: { command: "ls" }, time: t },
    { type: "tool.result", callId: "c1", output: "500 lines of ls", isError: false, time: t },
    { type: "tool.pruned", callIds: ["c1"], time: t },
  ]
  const header = { v: 1 as const, kind: "butterfly-session" as const, sessionId: "s", createdAt: t }
  const state = project(header, events)

  const result = state.timeline.find((e) => e.type === "tool.result")
  expect(result && "output" in result ? result.output : "").toBe(PRUNED_PLACEHOLDER)
})
