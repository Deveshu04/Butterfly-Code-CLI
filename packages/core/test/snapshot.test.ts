import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { now, type SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { project } from "../src/session/projector"
import { runUserTurn } from "../src/session/runner"
import { createSnapshot, listUntracked, restoreSnapshot } from "../src/session/snapshot"
import { ToolRegistry } from "../src/tool/registry"
import { runCommand } from "../src/tool/shell"
import { MockProvider } from "./helpers/mock-provider"

const t = now()

async function gitFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bfly-snap-"))
  await runCommand("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  })
  writeFileSync(join(dir, "app.ts"), "export const v = 1\n")
  await runCommand("git add -A && git commit -qm init", { cwd: dir })
  return dir
}

test("snapshot captures the worktree and restore brings files back", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")

  const tree = await createSnapshot(dir)
  expect(tree).toMatch(/^[0-9a-f]{40,64}$/)

  writeFileSync(join(dir, "app.ts"), "export const v = 999 // wrecked\n")
  const restored = await restoreSnapshot(dir, tree ?? "")
  expect(restored).toBe(true)
  // git autocrlf may checkout CRLF on Windows — normalize before comparing.
  expect(readFileSync(join(dir, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 2\n",
  )
}, 30_000)

test("snapshot returns null outside a git repo", async () => {
  expect(await createSnapshot(mkdtempSync(join(tmpdir(), "bfly-nogit-")))).toBeNull()
}, 20_000)

test("listUntracked lists untracked files, empty outside a repo", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "scratch.txt"), "hi\n")
  const untracked = await listUntracked(dir)
  expect(untracked).toContain("scratch.txt")
  expect(await listUntracked(mkdtempSync(join(tmpdir(), "bfly-nogit2-")))).toEqual([])
}, 20_000)

test("listUntracked returns non-ASCII filenames unquoted, not git's C-quoted escape form", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "café.txt"), "hi\n")
  const untracked = await listUntracked(dir)
  // git status --porcelain (without -z) C-quotes non-ASCII paths, e.g.
  // "caf\303\251.txt" — that literal escaped string must never show up here.
  expect(untracked).toContain("café.txt")
  expect(untracked.some((p) => p.includes("\\") || p.startsWith('"'))).toBe(false)
}, 20_000)

test("listUntracked expands an untracked directory into its individual files", async () => {
  const dir = await gitFixture()
  mkdirSync(join(dir, "newdir"))
  writeFileSync(join(dir, "newdir", "inside.txt"), "hi\n")
  const untracked = await listUntracked(dir)
  expect(untracked).toContain("newdir/inside.txt")
  expect(untracked).not.toContain("newdir/")
}, 20_000)

test("restore deletes a non-ASCII-named file created after the snapshot", async () => {
  const dir = await gitFixture()
  const baseline = await listUntracked(dir)
  const tree = await createSnapshot(dir)
  expect(tree).not.toBeNull()
  writeFileSync(join(dir, "café.txt"), "created after the snapshot\n")

  const restored = await restoreSnapshot(dir, tree ?? "", { untracked: baseline })
  expect(restored).toBe(true)
  expect(existsSync(join(dir, "café.txt"))).toBe(false)
}, 30_000)

test("restore deletes files created after the snapshot when a baseline is given", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "before.txt"), "existed before the snapshot too\n")
  const baseline = await listUntracked(dir)
  expect(baseline).toContain("before.txt")

  const tree = await createSnapshot(dir)
  expect(tree).not.toBeNull()
  writeFileSync(join(dir, "after.txt"), "created after the snapshot\n")

  const restored = await restoreSnapshot(dir, tree ?? "", { untracked: baseline })
  expect(restored).toBe(true)
  expect(existsSync(join(dir, "after.txt"))).toBe(false)
  expect(existsSync(join(dir, "before.txt"))).toBe(true)
}, 30_000)

test("restore without a baseline leaves untracked files alone (back-compat)", async () => {
  const dir = await gitFixture()
  const tree = await createSnapshot(dir)
  expect(tree).not.toBeNull()
  writeFileSync(join(dir, "after.txt"), "created after\n")

  const restored = await restoreSnapshot(dir, tree ?? "")
  expect(restored).toBe(true)
  expect(existsSync(join(dir, "after.txt"))).toBe(true)
}, 30_000)

test("runner journals turn.snapshot before the user message", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "hi" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-snapjr-")))
  await runUserTurn(
    {
      provider,
      registry: new ToolRegistry(),
      journal,
      rules: { "*": "allow" },
      model: "m",
      system: "s",
      cwd: "/w",
      createSnapshot: async () => "a".repeat(40),
    },
    "task",
  )
  const { events } = SessionJournal.replay(journal.path)
  expect(events[0]?.type).toBe("turn.snapshot")
  expect(events[1]?.type).toBe("message.user")
})

test("session.rewound truncates the projected timeline", () => {
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "keep me", time: t },
    { type: "message.assistant", id: "a1", text: "kept reply", time: t },
    { type: "turn.snapshot", tree: "b".repeat(40), time: t },
    { type: "message.user", id: "u2", text: "undone ask", time: t },
    { type: "message.assistant", id: "a2", text: "undone reply", time: t },
    { type: "session.rewound", toIndex: 2, time: t },
  ]
  const header = { v: 1 as const, kind: "butterfly-session" as const, sessionId: "s", createdAt: t }
  const texts = project(header, events)
    .timeline.map((e) => ("text" in e ? e.text : e.type))
    .join("|")
  expect(texts).toContain("keep me")
  expect(texts).not.toContain("undone")
})

test("/undo of a turn that compacted mid-flight replays to a correct, non-empty timeline", () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-undo-compact-"))
  const journal = SessionJournal.create(dir)
  journal.append({ type: "message.user", id: "u1", text: "old ask", time: t }) // 0
  journal.append({ type: "message.assistant", id: "a1", text: "old reply", time: t }) // 1
  journal.append({ type: "turn.snapshot", tree: "b".repeat(40), untracked: [], time: t }) // 2
  journal.append({ type: "message.user", id: "u2", text: "the doomed ask", time: t }) // 3
  journal.append({ type: "message.assistant", id: "a2", text: "step one", time: t }) // 4
  // mid-turn compaction supersedes everything before the current step
  journal.append({
    type: "session.compacted",
    summary: "recap of it all",
    keepFromIndex: 4,
    time: t,
  }) // 5
  journal.append({ type: "message.assistant", id: "a3", text: "step two", time: t }) // 6
  // /undo -> rewind to this turn's snapshot index (2), which is BEHIND the cut
  journal.append({ type: "session.rewound", toIndex: 2, time: t }) // 7

  const { header, events } = SessionJournal.replay(journal.path)
  const timeline = project(header, events).timeline
  expect(timeline.length).toBeGreaterThan(0)
  expect(timeline.map((e) => ("text" in e ? e.text : e.type))).toEqual(["old ask", "old reply"])
})
