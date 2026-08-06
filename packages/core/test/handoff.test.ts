import { expect, test } from "bun:test"
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assemble } from "../src/session/assembly"
import {
  consumeHandoff,
  formatHandoffAge,
  HANDOFF_MAX_CHARS,
  HANDOFF_PROMPT,
  HANDOFF_TRUNCATION_MARKER,
  handoffPaths,
  preloadHandoff,
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


test("runHandoffTurn reports costUSD from the model's pricing", async () => {
  const journal = SessionJournal.create(tempDir("bfly-handoff-cost-"))
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "## Goal\nship it" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1_000, output: 500, cacheRead: 200, cacheWrite: 0 },
      },
    ],
  ])
  const result = await runHandoffTurn({
    provider,
    journal,
    model: "mock-model",
    system: "sys",
    cwd: "/w",
    // USD per 1M tokens (models.dev shape).
    cost: { input: 3, output: 15, cacheRead: 0.3 },
  })
  expect(result.costUSD).toBeCloseTo((1_000 * 3 + 500 * 15 + 200 * 0.3) / 1_000_000, 12)
  expect(result.budgetExceeded).toBe(false)
})

test("runHandoffTurn without pricing reports zero cost, not NaN", async () => {
  const journal = SessionJournal.create(tempDir("bfly-handoff-cost-none-"))
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "## Goal\nship it" },
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
  expect(result.costUSD).toBe(0)
})

test("runHandoffTurn honours maxSpendUSD — the cap notice fires and the turn is flagged", async () => {
  const journal = SessionJournal.create(tempDir("bfly-handoff-cap-"))
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "## Goal\nship it" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const notices: string[] = []
  const result = await runHandoffTurn({
    provider,
    journal,
    model: "mock-model",
    system: "sys",
    cwd: "/w",
    cost: { input: 3 },
    maxSpendUSD: 0.5,
    onEvent: (event) => {
      if (event.type === "notice") notices.push(event.text)
    },
  })
  expect(result.costUSD).toBeCloseTo(3, 12)
  expect(result.budgetExceeded).toBe(true)
  expect(notices.some((text) => text.includes("dollar budget reached"))).toBe(true)
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


test("preloadHandoff leaves the task text alone and stays silent when nothing is pending", () => {
  const cwd = tempDir("bfly-handoff-preload-none-")
  const result = preloadHandoff(cwd, "do the thing")
  expect(result.taskText).toBe("do the thing")
  expect(result.loaded).toBe(false)
  expect(result.notice).toBeUndefined()
  expect(result.skipped).toBeUndefined()
})

test("preloadHandoff prepends the handoff AND returns a user-visible notice naming path + age", () => {
  const cwd = tempDir("bfly-handoff-preload-notice-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const saved = saveHandoff(cwd, "## Goal\nBuild a widget\n", false, journal)

  // A fresh session (its own journal) picking up yesterday's handoff.
  const freshJournal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const result = preloadHandoff(cwd, "carry on", {
    journalPath: freshJournal.path,
    now: () => Date.now() + 2 * 60 * 60 * 1000,
  })

  expect(result.loaded).toBe(true)
  expect(result.taskText).toContain("Build a widget")
  expect(result.taskText.endsWith("carry on")).toBe(true)
  expect(result.notice).toBeDefined()
  expect(result.notice).toContain(saved.path)
  expect(result.notice).toContain("2h ago")
  // Consumed exactly once.
  expect(existsSync(saved.path)).toBe(false)
  expect(preloadHandoff(cwd, "carry on").loaded).toBe(false)
})

test("preloadHandoff does NOT consume a handoff THIS session just wrote (self-reinjection guard)", () => {
  const cwd = tempDir("bfly-handoff-self-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const saved = saveHandoff(cwd, "## Goal\nBuild a widget\n", false, journal)

  // Same session that ran /handoff now submits its first message.
  const result = preloadHandoff(cwd, "one more thing", { journalPath: journal.path })

  expect(result.loaded).toBe(false)
  expect(result.skipped).toBe("self")
  expect(result.taskText).toBe("one more thing")
  expect(result.notice).toBeUndefined()
  // Left intact for the session that actually needs it.
  expect(existsSync(saved.path)).toBe(true)

  // The NEXT session (a different journal) still finds it.
  const next = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const later = preloadHandoff(cwd, "continue", { journalPath: next.path })
  expect(later.loaded).toBe(true)
  expect(later.taskText).toContain("Build a widget")
})

test("preloadHandoff survives an unreadable/corrupt journal by keeping the handoff pending", () => {
  const cwd = tempDir("bfly-handoff-corrupt-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const saved = saveHandoff(cwd, "## Goal\nBuild a widget\n", false, journal)
  appendFileSync(journal.path, "{not json at all\n")

  // The guard must still see this session's own session.handoff line rather
  // than throwing (or failing open into a self-reinjection).
  const result = preloadHandoff(cwd, "one more thing", { journalPath: journal.path })
  expect(result.skipped).toBe("self")
  expect(existsSync(saved.path)).toBe(true)
})

test("formatHandoffAge renders coarse, human ages", () => {
  expect(formatHandoffAge(5_000)).toBe("just now")
  expect(formatHandoffAge(12 * 60 * 1000)).toBe("12m ago")
  expect(formatHandoffAge(3 * 60 * 60 * 1000)).toBe("3h ago")
  expect(formatHandoffAge(2 * 24 * 60 * 60 * 1000)).toBe("2d ago")
})
