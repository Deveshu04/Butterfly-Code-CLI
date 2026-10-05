import { expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionJournal, saveHandoff } from "@butterfly/core"
import { applyResumeHandoff } from "../src/run"

/** `butterfly run --resume-handoff`, tested without spinning up runHeadless. */

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("without --resume-handoff, a pending handoff is left untouched", () => {
  const cwd = tempDir("bfly-resume-off-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const saved = saveHandoff(cwd, "## Goal\ndo the thing\n", false, journal)

  const result = applyResumeHandoff(cwd, "continue please", false)

  expect(result).toBe("continue please")
  expect(existsSync(saved.path)).toBe(true)
})

test("--resume-handoff with nothing pending leaves the task text unchanged", () => {
  const cwd = tempDir("bfly-resume-none-")
  const result = applyResumeHandoff(cwd, "continue please", true)
  expect(result).toBe("continue please")
})

test("--resume-handoff preloads a pending handoff ahead of the task and consumes it", () => {
  const cwd = tempDir("bfly-resume-on-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const doc = "## Goal\nBuild a widget\n## Continue with\nWire up the CLI flag\n"
  const saved = saveHandoff(cwd, doc, false, journal)

  const result = applyResumeHandoff(cwd, "continue please", true)

  expect(result).toContain("Build a widget")
  expect(result).toContain("Wire up the CLI flag")
  expect(result.endsWith("continue please")).toBe(true)
  // Consumed: the pending file is gone (renamed), never double-loaded.
  expect(existsSync(saved.path)).toBe(false)
  expect(applyResumeHandoff(cwd, "continue again", true)).toBe("continue again")
})

test("--resume-handoff reports what it loaded through the notify seam (never silent)", () => {
  const cwd = tempDir("bfly-resume-notice-")
  const journal = SessionJournal.create(join(cwd, ".butterfly", "sessions"))
  const saved = saveHandoff(cwd, "## Goal\nBuild a widget\n", false, journal)
  const notices: string[] = []

  applyResumeHandoff(cwd, "continue please", true, (text) => notices.push(text))

  expect(notices.length).toBe(1)
  expect(notices[0]).toContain(saved.path)
  // Nothing pending → nothing announced.
  applyResumeHandoff(cwd, "continue please", true, (text) => notices.push(text))
  expect(notices.length).toBe(1)
})
