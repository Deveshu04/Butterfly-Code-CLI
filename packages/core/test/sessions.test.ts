import { expect, test } from "bun:test"
import { mkdtempSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { now } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { exportSessionMarkdown, forkSession, listSessions } from "../src/session/sessions"

const t = now()

test("listSessions returns newest first with first-user-message titles", () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-sessions-"))

  const older = SessionJournal.create(dir, "older-session")
  older.append({ type: "message.user", id: "u", text: "fix the login bug", time: t })
  older.append({
    type: "turn.completed",
    model: "m",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    time: t,
  })
  utimesSync(older.path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

  const newer = SessionJournal.create(dir, "newer-session")
  newer.append({
    type: "message.user",
    id: "u",
    text: "add dark mode to the settings page",
    time: t,
  })

  const sessions = listSessions(dir)
  expect(sessions.length).toBe(2)
  expect(sessions[0]?.id).toBe("newer-session")
  expect(sessions[0]?.title).toContain("dark mode")
  expect(sessions[1]?.id).toBe("older-session")
  expect(sessions[1]?.turns).toBe(1)
})

test("listSessions survives corrupt journals and empty dirs", () => {
  expect(listSessions(join(tmpdir(), "does-not-exist-xyz"))).toEqual([])
  const dir = mkdtempSync(join(tmpdir(), "bfly-sessions-bad-"))
  require("node:fs").writeFileSync(join(dir, "junk.jsonl"), "{broken\n")
  expect(listSessions(dir)).toEqual([])
})

test("forkSession copies history into a fresh journal with a new id", () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-fork-"))
  const original = SessionJournal.create(dir, "orig")
  original.append({ type: "message.user", id: "u", text: "shared history", time: t })

  const forkedPath = forkSession(original.path, dir)
  const forked = SessionJournal.replay(forkedPath)
  expect(forked.header.sessionId).not.toBe("orig")
  expect(forked.events.length).toBe(1)

  // Divergence: appending to the fork leaves the original untouched.
  SessionJournal.open(forkedPath).append({
    type: "message.user",
    id: "u2",
    text: "fork only",
    time: t,
  })
  expect(SessionJournal.replay(original.path).events.length).toBe(1)
})

test("export renders user, assistant, and tool activity as markdown", () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-export-"))
  const journal = SessionJournal.create(dir)
  journal.append({ type: "message.user", id: "u", text: "create a version file", time: t })
  journal.append({ type: "message.assistant", id: "a", text: "Done — created it.", time: t })
  journal.append({
    type: "tool.call",
    callId: "c1",
    name: "edit",
    input: { file_path: "V.txt" },
    time: t,
  })
  journal.append({
    type: "tool.result",
    callId: "c1",
    output: "Edited V.txt",
    isError: false,
    time: t,
  })

  const markdown = exportSessionMarkdown(journal.path)
  expect(markdown).toContain("# butterfly session")
  expect(markdown).toContain("create a version file")
  expect(markdown).toContain("Done — created it.")
  expect(markdown).toContain("edit")
  expect(markdown).toContain("Edited V.txt")
  // A session nobody rewound carries no undone chrome at all.
  expect(markdown).not.toContain("undone")
})

test("export labels the region /undo rewound out of the conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-export-undone-"))
  const journal = SessionJournal.create(dir)
  journal.append({ type: "message.user", id: "u1", text: "kept ask", time: t }) // 0
  journal.append({ type: "message.assistant", id: "a1", text: "kept reply", time: t }) // 1
  journal.append({ type: "turn.snapshot", tree: "b".repeat(40), untracked: [], time: t }) // 2
  journal.append({ type: "message.user", id: "u2", text: "undone ask", time: t }) // 3
  journal.append({ type: "message.assistant", id: "a2", text: "undone reply", time: t }) // 4
  journal.append({ type: "session.rewound", toIndex: 2, time: t }) // 5 — undoes [2,5)
  journal.append({ type: "message.user", id: "u3", text: "live again", time: t }) // 6

  const markdown = exportSessionMarkdown(journal.path)

  // The undone region is delimited on both sides like session.compacted:
  // nothing is dropped, but readers (and the Ctrl+O pager) can tell live from undone.
  expect(markdown).toContain("/undo rewound")
  expect(markdown).toContain("end of undone")
  // Undone content is still present, and every undone turn carries the
  // label — not just the region's first line.
  expect(markdown).toContain("undone reply")
  expect(markdown).toContain("## (undone) ❯ undone ask")
  // ...and it no longer has the live-prompt heading the pager's { } jumps use.
  expect(markdown).not.toContain("## ❯ undone ask")
  // Live turns on both sides of the region are untouched.
  expect(markdown).toContain("## ❯ kept ask")
  expect(markdown).toContain("## ❯ live again")

  const lines = markdown.split("\n")
  const open = lines.findIndex((line) => line.includes("/undo rewound"))
  const close = lines.findIndex((line) => line.includes("end of undone"))
  const undoneAsk = lines.findIndex((line) => line.includes("undone ask"))
  const liveAgain = lines.findIndex((line) => line.includes("live again"))
  expect(open).toBeLessThan(undoneAsk)
  expect(undoneAsk).toBeLessThan(close)
  expect(close).toBeLessThan(liveAgain)
})

test("export unions overlapping rewinds and never opens a region it does not close", () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-export-undone2-"))
  const journal = SessionJournal.create(dir)
  journal.append({ type: "message.user", id: "u1", text: "first ask", time: t }) // 0
  journal.append({ type: "message.user", id: "u2", text: "second ask", time: t }) // 1
  journal.append({ type: "session.rewound", toIndex: 1, time: t }) // 2 — undoes [1,2)
  journal.append({ type: "message.user", id: "u3", text: "third ask", time: t }) // 3
  journal.append({ type: "session.rewound", toIndex: 0, time: t }) // 4 — undoes [0,4)

  const markdown = exportSessionMarkdown(journal.path)
  // The second rewind swallows the first one's region: one open, one close.
  expect(markdown.split("\n").filter((line) => line.includes("/undo rewound")).length).toBe(1)
  expect(markdown.split("\n").filter((line) => line.includes("end of undone")).length).toBe(1)
  // Everything is undone, so nothing keeps the live-prompt heading.
  expect(markdown).not.toContain("## ❯ ")
  expect(markdown).toContain("## (undone) ❯ first ask")
  expect(markdown).toContain("## (undone) ❯ third ask")
})
