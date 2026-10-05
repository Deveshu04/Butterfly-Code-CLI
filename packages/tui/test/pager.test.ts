import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportSessionMarkdown, now, SessionJournal } from "@butterfly/core"
import { buildPagerDoc, searchPagerLines, stepLine } from "../src/pager"

test("buildPagerDoc splits the export into lines and finds user-prompt headings", () => {
  const source = [
    "# butterfly session abc",
    "",
    "## ❯ first prompt",
    "",
    "some reply text",
    "",
    "## ❯ second prompt",
    "",
    "more reply",
  ].join("\n")
  const doc = buildPagerDoc(source)
  expect(doc.source).toBe(source)
  expect(doc.lines.length).toBe(9)
  // "## ❯ " is the heading exportSessionMarkdown emits for user messages.
  expect(doc.promptLines).toEqual([2, 6])
})

test("buildPagerDoc finds no prompt lines in a doc with no user messages", () => {
  const doc = buildPagerDoc("# butterfly session abc\n\n> started now\n")
  expect(doc.promptLines).toEqual([])
})

test("{ } prompt jumps skip turns /undo rewound out of the conversation", () => {
  // Uses a real journal export so the heading coupling is actually tested.
  const dir = mkdtempSync(join(tmpdir(), "bfly-pager-undone-"))
  const journal = SessionJournal.create(dir)
  journal.append({ type: "message.user", id: "u1", text: "kept ask", time: now() }) // 0
  journal.append({ type: "turn.snapshot", tree: "b".repeat(40), untracked: [], time: now() }) // 1
  journal.append({ type: "message.user", id: "u2", text: "undone ask", time: now() }) // 2
  journal.append({ type: "session.rewound", toIndex: 1, time: now() }) // 3 — undoes [1,3)
  journal.append({ type: "message.user", id: "u3", text: "live again", time: now() }) // 4

  const doc = buildPagerDoc(exportSessionMarkdown(journal.path))
  expect(doc.promptLines.map((i) => doc.lines[i])).toEqual(["## ❯ kept ask", "## ❯ live again"])
  // Undone history is labelled and still searchable.
  expect(doc.source).toContain("undone ask")
  expect(searchPagerLines(doc.lines, "undone ask").length).toBe(1)
})

test("searchPagerLines finds case-insensitive substring matches, empty query finds nothing", () => {
  const lines = ["hello world", "FIND ME here", "nothing", "find me again"]
  expect(searchPagerLines(lines, "find me")).toEqual([1, 3])
  expect(searchPagerLines(lines, "")).toEqual([])
  expect(searchPagerLines(lines, "zzz")).toEqual([])
})

test("stepLine walks forward/backward through a sorted index list, wrapping at both ends", () => {
  const indices = [2, 5, 9]
  expect(stepLine(indices, 0, 1)).toBe(2)
  expect(stepLine(indices, 2, 1)).toBe(5)
  expect(stepLine(indices, 9, 1)).toBe(2) // wraps forward past the last entry
  expect(stepLine(indices, 9, -1)).toBe(5)
  expect(stepLine(indices, 2, -1)).toBe(9) // wraps backward past the first entry
  expect(stepLine([], 0, 1)).toBe(-1)
  expect(stepLine([], 0, -1)).toBe(-1)
})
