import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assemble } from "../src/session/assembly"
import {
  consumeHandoff,
  HANDOFF_MAX_CHARS,
  HANDOFF_PROMPT,
  HANDOFF_TRUNCATION_MARKER,
  handoffPaths,
  renderHandoffPreload,
  runHandoffTurn,
  saveHandoff,
  truncateHandoffDoc,
} from "../src/session/handoff"
import { SessionJournal } from "../src/session/journal"
import { project } from "../src/session/projector"
import { runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }


test("truncateHandoffDoc leaves short docs untouched", () => {
  const result = truncateHandoffDoc("  ## Goal\nship it\n  ")
  expect(result).toEqual({ doc: "## Goal\nship it", truncated: false })
})

test("truncateHandoffDoc hard-truncates to HANDOFF_MAX_CHARS with a visible marker", () => {
  const long = "x".repeat(HANDOFF_MAX_CHARS + 500)
  const result = truncateHandoffDoc(long)
  expect(result.truncated).toBe(true)
  expect(result.doc.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
  expect(result.doc.endsWith(HANDOFF_TRUNCATION_MARKER)).toBe(true)
})


test("runHandoffTurn sends the fixed template prompt with tools masked off, seeing prior history", async () => {
  const journal = SessionJournal.create(tempDir("bfly-handoff-journal-"))
  // Simulate a session already underway before /handoff runs.
  const priorProvider = new MockProvider([
    [
      { type: "text-delta", text: "hi there" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  await runUserTurn(
    {
      provider: priorProvider,
      registry: new ToolRegistry(),
      journal,
      rules: { "*": "allow" },
      model: "mock-model",
      system: "You are Butterfly.",
      cwd: "/w",
    },
    "hello, let's build a widget",
  )

  const provider = new MockProvider([
    [
      { type: "text-delta", text: "## Goal\nBuild a widget\n" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const result = await runHandoffTurn({
    provider,
    journal,
    model: "mock-model",
    system: "You are Butterfly.",
    cwd: "/w",
  })

  expect(result.doc).toBe("## Goal\nBuild a widget")
  expect(result.truncated).toBe(false)

  expect(provider.requests.length).toBe(1)
  const request = provider.requests[0]
  // Tools masked off: nothing registered, so the provider sees an empty list.
  expect(request?.tools).toEqual([])
  // The last user-role message is the fixed template prompt, not free text.
  const last = request?.messages.at(-1)
  expect(last?.role).toBe("user")
  expect(last && "content" in last ? last.content : "").toBe(HANDOFF_PROMPT)
  // The model still sees the prior conversation (normal runner, not a fresh context).
  const rendered = JSON.stringify(request?.messages)
  expect(rendered).toContain("hello, let's build a widget")
  expect(rendered).toContain("hi there")

  // Bounded to one turn: the journal gained exactly one more user/assistant/
  // turn.completed triplet, no tool.call/tool.result at all.
  const { events } = SessionJournal.replay(journal.path)
  const types = events.map((e) => e.type)
  expect(types).toEqual([
    "message.user",
    "message.assistant",
    "turn.completed",
    "message.user",
    "message.assistant",
    "turn.completed",
  ])
})

test("runHandoffTurn hard-truncates a runaway response", async () => {
  const journal = SessionJournal.create(tempDir("bfly-handoff-journal-"))
  const long = "y".repeat(HANDOFF_MAX_CHARS + 1000)
  const provider = new MockProvider([
    [
      { type: "text-delta", text: long },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const result = await runHandoffTurn({
    provider,
    journal,
    model: "mock-model",
    system: "sys",
    cwd: "/w",
  })
  expect(result.truncated).toBe(true)
  expect(result.doc.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS)
})


test("handoffPaths points at the fixed main file and archive dir under .butterfly", () => {
  const paths = handoffPaths("/repo")
  expect(paths.main).toBe(join("/repo", ".butterfly", "handoff.md"))
  expect(paths.archiveDir).toBe(join("/repo", ".butterfly", "handoffs"))
})

test("saveHandoff writes the main file and a timestamped archive copy, and journals bookkeeping-only session.handoff", () => {
  const cwd = tempDir("bfly-handoff-save-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const doc = "## Goal\nship it\n## State\n- Active: writing tests\n"

  const result = saveHandoff(cwd, doc, false, journal)

  expect(readFileSync(result.path, "utf8")).toBe(doc)
  expect(readFileSync(result.archivePath, "utf8")).toBe(doc)
  expect(result.path).toBe(join(cwd, ".butterfly", "handoff.md"))
  expect(result.archivePath.startsWith(join(cwd, ".butterfly", "handoffs"))).toBe(true)
  expect(result.chars).toBe(doc.length)
  expect(result.truncated).toBe(false)

  const { header, events } = SessionJournal.replay(journal.path)
  const handoffEvents = events.filter((e) => e.type === "session.handoff")
  expect(handoffEvents.length).toBe(1)
  const event = handoffEvents[0]
  expect(event && "path" in event ? event.path : "").toBe(result.path)
  expect(event && "archivePath" in event ? event.archivePath : "").toBe(result.archivePath)
  expect(event && "chars" in event ? event.chars : -1).toBe(doc.length)

  // Bookkeeping-only: the projector must fold it out of the model timeline,
  // same as turn.snapshot/hook.run.
  const projected = project(header, events)
  expect(projected.timeline.some((e) => e.type === "session.handoff")).toBe(false)
  // And assembly must never forward it into the provider-facing transcript.
  const messages = assemble({ system: "sys", timeline: projected.timeline })
  expect(JSON.stringify(messages)).not.toContain("session.handoff")
})

test("saveHandoff records truncated:true when the doc was cut", () => {
  const cwd = tempDir("bfly-handoff-save-trunc-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const result = saveHandoff(cwd, "short doc but marked truncated upstream", true, journal)
  expect(result.truncated).toBe(true)
  const { events } = SessionJournal.replay(journal.path)
  const event = events.find((e) => e.type === "session.handoff")
  expect(event && "truncated" in event ? event.truncated : false).toBe(true)
})


test("consumeHandoff returns undefined when there is no pending handoff", () => {
  const cwd = tempDir("bfly-handoff-empty-")
  expect(consumeHandoff(cwd)).toBeUndefined()
})

test("consumeHandoff returns the content once, then renames the file so it isn't double-loaded", () => {
  const cwd = tempDir("bfly-handoff-consume-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const doc = "## Goal\ncontinue the widget\n"
  const saved = saveHandoff(cwd, doc, false, journal)

  const first = consumeHandoff(cwd)
  expect(first).toBe(doc)
  expect(existsSync(saved.path)).toBe(false)
  expect(existsSync(`${saved.path}.consumed`)).toBe(true)

  const second = consumeHandoff(cwd)
  expect(second).toBeUndefined()

  // The permanent archive copy is untouched throughout.
  expect(existsSync(saved.archivePath)).toBe(true)
})


test("renderHandoffPreload labels the doc for injection into a fresh session", () => {
  const rendered = renderHandoffPreload("## Goal\ndo the thing")
  expect(rendered).toContain("handoff from a previous session")
  expect(rendered).toContain("## Goal\ndo the thing")
})

test("preload injection: a fresh session's first turn sees the consumed handoff ahead of the new task", async () => {
  const cwd = tempDir("bfly-handoff-preload-")
  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const oldJournal = SessionJournal.create(sessionsDir)
  const savedDoc = "## Goal\nBuild a widget\n## Continue with\nWire up the CLI flag\n"
  saveHandoff(cwd, savedDoc, false, oldJournal)

  // The consuming caller (TUI's /new firstTurn block, or CLI's
  // --resume-handoff) reads + renames, then prepends into the NEW session's
  // first user turn.
  const pending = consumeHandoff(cwd)
  expect(pending).toBe(savedDoc)

  const freshJournal = SessionJournal.create(sessionsDir)
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "picking up where we left off" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const taskText = pending
    ? `${renderHandoffPreload(pending)}\n\ncontinue the work`
    : "continue the work"
  await runUserTurn(
    {
      provider,
      registry: new ToolRegistry(),
      journal: freshJournal,
      rules: { "*": "allow" },
      model: "mock-model",
      system: "sys",
      cwd,
    },
    taskText,
  )

  const request = provider.requests[0]
  const rendered = JSON.stringify(request?.messages)
  expect(rendered).toContain("Build a widget")
  expect(rendered).toContain("Wire up the CLI flag")
  expect(rendered).toContain("continue the work")

  // And the handoff cannot be loaded a second time by a later /new.
  expect(consumeHandoff(cwd)).toBeUndefined()
})
