import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCommand } from "../src/tool/shell"
import {
  countActiveWorktrees,
  createWorktree,
  MAX_CONCURRENT_WORKTREES,
  removeWorktree,
  worktreeStatus,
  worktreesRoot,
} from "../src/tool/worktree"
import { nonRepoDir } from "./helpers/temp"

async function gitFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bfly-wt-"))
  await runCommand("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  })
  writeFileSync(join(dir, "app.ts"), "export const v = 1\n")
  await runCommand("git add -A && git commit -qm init", { cwd: dir })
  return dir
}

test("createWorktree refuses outside a git repo", async () => {
  const dir = nonRepoDir("bfly-wt-nogit-")
  const result = await createWorktree(dir, "task1")
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain("git repository")
}, 20_000)

test("createWorktree checks out HEAD into .butterfly/worktrees/<taskId>", async () => {
  const dir = await gitFixture()
  const result = await createWorktree(dir, "task1")
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.path).toBe(join(worktreesRoot(dir), "task1"))
    expect(existsSync(join(result.path, "app.ts"))).toBe(true)
    expect(readFileSync(join(result.path, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
      "export const v = 1\n",
    )
    expect(result.baseSha).toMatch(/^[0-9a-f]{7,64}$/)
  }
}, 30_000)

test("countActiveWorktrees reflects directories on disk, zero before any exist", async () => {
  const dir = await gitFixture()
  expect(countActiveWorktrees(dir)).toBe(0)
  await createWorktree(dir, "task1")
  expect(countActiveWorktrees(dir)).toBe(1)
}, 30_000)

test("createWorktree refuses a 5th concurrent worktree past the cap of 4", async () => {
  const dir = await gitFixture()
  for (let i = 0; i < MAX_CONCURRENT_WORKTREES; i++) {
    const result = await createWorktree(dir, `task${i}`)
    expect(result.ok).toBe(true)
  }
  const overCap = await createWorktree(dir, "task-over-cap")
  expect(overCap.ok).toBe(false)
  if (!overCap.ok) expect(overCap.error).toContain(String(MAX_CONCURRENT_WORKTREES))
}, 60_000)

test("worktreeStatus is clean on a freshly created worktree", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const status = await worktreeStatus(created.path, created.baseSha)
  expect(status.dirty).toBe(false)
  expect(status.changedFiles).toBe(0)
  expect(status.commitsAhead).toBe(0)
}, 30_000)

test("worktreeStatus reports dirty after an uncommitted edit", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  writeFileSync(join(created.path, "app.ts"), "export const v = 2\n")
  const status = await worktreeStatus(created.path, created.baseSha)
  expect(status.dirty).toBe(true)
  expect(status.changedFiles).toBeGreaterThan(0)
  expect(status.commitsAhead).toBe(0)
}, 30_000)

test("worktreeStatus reports dirty after a commit made inside the worktree", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  writeFileSync(join(created.path, "app.ts"), "export const v = 2\n")
  await runCommand("git add -A && git commit -qm edit", { cwd: created.path })
  const status = await worktreeStatus(created.path, created.baseSha)
  expect(status.dirty).toBe(true)
  expect(status.commitsAhead).toBe(1)
}, 30_000)

test("the main repo working tree is never touched by edits inside the worktree", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  writeFileSync(join(created.path, "app.ts"), "export const v = 999\n")
  expect(readFileSync(join(dir, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 1\n",
  )
}, 30_000)

test("removeWorktree removes a clean worktree and frees a concurrency slot", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  expect(countActiveWorktrees(dir)).toBe(1)
  const removed = await removeWorktree(dir, created.path)
  expect(removed.ok).toBe(true)
  expect(existsSync(created.path)).toBe(false)
  expect(countActiveWorktrees(dir)).toBe(0)
}, 30_000)

/**
 * Fail-safe: a git call that fails or times out must never read as "clean",
 * since clean authorizes force-removing the subagent's work. Unknown means
 * dirty: reported, never removed.
 */
test("worktreeStatus fails SAFE: a failing git status reports dirty + undetermined, never clean", async () => {
  const dir = nonRepoDir("bfly-wt-nogit-") // `git status` here exits 128: "not a git repository"
  const status = await worktreeStatus(dir, "0".repeat(40))
  expect(status.dirty).toBe(true)
  expect(status.undetermined).toBeTruthy()
  expect(status.undetermined ?? "").toContain("status")
}, 20_000)

test("worktreeStatus fails SAFE when the base sha is unknown: commits made inside are undetectable, so the worktree is dirty", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  // baseSha "" = the post-add `git rev-parse HEAD` failed at create time.
  const status = await worktreeStatus(created.path, "")
  expect(status.dirty).toBe(true)
  expect(status.undetermined).toBeTruthy()
  expect(status.changedFiles).toBe(0)
}, 30_000)

test("worktreeStatus fails SAFE when rev-list cannot be resolved (bogus base sha)", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const status = await worktreeStatus(created.path, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
  expect(status.dirty).toBe(true)
  expect(status.undetermined).toBeTruthy()
}, 30_000)

test("removeWorktree reports a typed failure (with the reason) instead of pretending it succeeded", async () => {
  const dir = await gitFixture()
  const created = await createWorktree(dir, "task1")
  expect(created.ok).toBe(true)
  if (!created.ok) return
  // A locked worktree (like a lingering child on Windows):
  // `git worktree remove --force` exits 128 while `git status` reports clean.
  await runCommand(`git worktree lock "${created.path}"`, { cwd: dir })
  const removed = await removeWorktree(dir, created.path)
  expect(removed.ok).toBe(false)
  if (!removed.ok) expect(removed.error.length).toBeGreaterThan(0)
  expect(existsSync(created.path)).toBe(true)
}, 30_000)

test("createWorktree reports whether the MAIN tree had uncommitted changes (HEAD-only checkout)", async () => {
  const dir = await gitFixture()
  const clean = await createWorktree(dir, "task1")
  expect(clean.ok).toBe(true)
  if (clean.ok) expect(clean.mainTreeDirty).toBe(false)

  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")
  const dirty = await createWorktree(dir, "task2")
  expect(dirty.ok).toBe(true)
  if (dirty.ok) {
    expect(dirty.mainTreeDirty).toBe(true)
    // The worktree is a checkout of HEAD, so it does NOT see that edit.
    expect(readFileSync(join(dirty.path, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
      "export const v = 1\n",
    )
  }
}, 40_000)
