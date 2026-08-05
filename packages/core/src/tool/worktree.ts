import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { GIT_TIMEOUT_MS, isGitRepo } from "../session/snapshot"
import { runCommand } from "./shell"


export const MAX_CONCURRENT_WORKTREES = 4

export function worktreesRoot(cwd: string): string {
  return join(cwd, ".butterfly", "worktrees")
}

export function countActiveWorktrees(cwd: string): number {
  const root = worktreesRoot(cwd)
  if (!existsSync(root)) return 0
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
  } catch {
    return 0
  }
}

export type CreateWorktreeResult =
  | {
      ok: true
      path: string
      baseSha: string
      mainTreeDirty: boolean
    }
  | { ok: false; error: string }

export async function createWorktree(cwd: string, taskId: string): Promise<CreateWorktreeResult> {
  if (!isGitRepo(cwd)) {
    return {
      ok: false,
      error:
        "Worktree isolation requires a git repository; none was detected at this working directory.",
    }
  }
  if (countActiveWorktrees(cwd) >= MAX_CONCURRENT_WORKTREES) {
    return {
      ok: false,
      error: `Worktree isolation refused: ${MAX_CONCURRENT_WORKTREES} concurrent isolated worktrees already exist under .butterfly/worktrees. Clean up a finished one (or merge/discard a dirty one) before starting another.`,
    }
  }

  const main = await runCommand("git status --porcelain", { cwd, timeoutMs: GIT_TIMEOUT_MS })
  const mainTreeDirty =
    main.exitCode === 0 &&
    !main.timedOut &&
    main.stdout.split("\n").some((line) => line.trim() !== "")

  const root = worktreesRoot(cwd)
  mkdirSync(root, { recursive: true })
  const path = join(root, taskId)
  const add = await runCommand(`git worktree add "${path}" HEAD`, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (add.exitCode !== 0 || add.timedOut) {
    const detail = (add.stderr || add.stdout).trim().slice(0, 500)
    return { ok: false, error: `git worktree add failed: ${detail || "unknown error"}` }
  }

  const head = await runCommand("git rev-parse HEAD", { cwd: path, timeoutMs: GIT_TIMEOUT_MS })
  const baseSha = head.exitCode === 0 && !head.timedOut ? head.stdout.trim() : ""
  return { ok: true, path, baseSha, mainTreeDirty }
}

export interface WorktreeStatus {
  dirty: boolean
  changedFiles: number
  commitsAhead: number
  undetermined?: string
}

export async function worktreeStatus(path: string, baseSha: string): Promise<WorktreeStatus> {
  const status = await runCommand("git status --porcelain", {
    cwd: path,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (status.timedOut || status.exitCode !== 0) {
    const detail = (status.stderr || status.stdout).trim().slice(0, 200)
    return {
      dirty: true,
      changedFiles: 0,
      commitsAhead: 0,
      undetermined: `git status in the worktree ${status.timedOut ? "timed out" : `failed (exit ${status.exitCode})`}${detail ? `: ${detail}` : ""}`,
    }
  }
  const changedFiles = status.stdout.split("\n").filter((line) => line.trim() !== "").length

  if (baseSha === "") {
    return {
      dirty: true,
      changedFiles,
      commitsAhead: 0,
      undetermined:
        "the worktree's base commit was not recorded at creation time, so commits made inside it cannot be detected",
    }
  }

  const rev = await runCommand(`git rev-list --count ${baseSha}..HEAD`, {
    cwd: path,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (rev.timedOut || rev.exitCode !== 0) {
    const detail = (rev.stderr || rev.stdout).trim().slice(0, 200)
    return {
      dirty: true,
      changedFiles,
      commitsAhead: 0,
      undetermined: `git rev-list against the base commit ${rev.timedOut ? "timed out" : `failed (exit ${rev.exitCode})`}${detail ? `: ${detail}` : ""}`,
    }
  }
  const commitsAhead = Number.parseInt(rev.stdout.trim(), 10)
  if (!Number.isFinite(commitsAhead)) {
    return {
      dirty: true,
      changedFiles,
      commitsAhead: 0,
      undetermined: `git rev-list returned an unparseable count ("${rev.stdout.trim().slice(0, 40)}")`,
    }
  }

  return { dirty: changedFiles > 0 || commitsAhead > 0, changedFiles, commitsAhead }
}

export type RemoveWorktreeResult = { ok: true } | { ok: false; error: string }

export async function removeWorktree(cwd: string, path: string): Promise<RemoveWorktreeResult> {
  const remove = await runCommand(`git worktree remove "${path}" --force`, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (remove.timedOut || remove.exitCode !== 0) {
    const detail = (remove.stderr || remove.stdout).trim().slice(0, 300)
    return {
      ok: false,
      error: remove.timedOut
        ? "git worktree remove timed out"
        : `git worktree remove failed (exit ${remove.exitCode})${detail ? `: ${detail}` : ""}`,
    }
  }
  await runCommand("git worktree prune", { cwd, timeoutMs: GIT_TIMEOUT_MS })
  return { ok: true }
}
