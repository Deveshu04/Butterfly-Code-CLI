import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
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
  writeWorktreeMeta(cwd, taskId, { baseSha, created: Date.now() })
  return { ok: true, path, baseSha, mainTreeDirty }
}

// --- merge-back (orchestration): the parent reviews a subagent's worktree,
// then integrates or discards it. Metadata sits NEXT to the worktree dir
// (`<id>.json`), never inside it, so it can't leak into the diff.

export interface WorktreeMeta {
  baseSha: string
  created: number
  /** The subagent's brief, for /tasks-style listings. */
  task?: string
}

function metaPath(cwd: string, id: string): string {
  return join(worktreesRoot(cwd), `${id}.json`)
}

export function writeWorktreeMeta(cwd: string, id: string, meta: WorktreeMeta): void {
  try {
    mkdirSync(worktreesRoot(cwd), { recursive: true })
    writeFileSync(metaPath(cwd, id), JSON.stringify(meta))
  } catch {
    // metadata is a convenience; merge falls back to "base unknown"
  }
}

export function readWorktreeMeta(cwd: string, id: string): WorktreeMeta | undefined {
  try {
    return JSON.parse(readFileSync(metaPath(cwd, id), "utf8")) as WorktreeMeta
  } catch {
    return undefined
  }
}

export interface WorktreeEntry {
  id: string
  path: string
  meta?: WorktreeMeta
}

export function listWorktrees(cwd: string): WorktreeEntry[] {
  const root = worktreesRoot(cwd)
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        id: entry.name,
        path: join(root, entry.name),
        meta: readWorktreeMeta(cwd, entry.name),
      }))
  } catch {
    return []
  }
}

/** Accepts an id, an id prefix (≥ 6 chars), or the worktree's path. */
export function findWorktree(cwd: string, ref: string): WorktreeEntry | undefined {
  const needle = basename(ref.trim().replace(/[\\/]+$/, ""))
  const all = listWorktrees(cwd)
  const exact = all.find((w) => w.id === needle)
  if (exact) return exact
  const prefixed = needle.length >= 6 ? all.filter((w) => w.id.startsWith(needle)) : []
  return prefixed.length === 1 ? prefixed[0] : undefined
}

export type MergeWorktreeResult =
  | { ok: true; files: string[]; patchPath: string; removed: boolean }
  | { ok: false; error: string; conflict?: boolean }

export async function mergeWorktree(cwd: string, ref: string): Promise<MergeWorktreeResult> {
  const entry = findWorktree(cwd, ref)
  if (!entry) return { ok: false, error: `no isolated worktree matches "${ref}"` }
  const base = entry.meta?.baseSha
  if (!base) {
    return {
      ok: false,
      error: `the base commit of worktree ${entry.id} was not recorded — merge it by hand (cd "${entry.path}" && git diff)`,
    }
  }
  const add = await runCommand("git add -A", { cwd: entry.path, timeoutMs: GIT_TIMEOUT_MS })
  if (add.exitCode !== 0 || add.timedOut) {
    return {
      ok: false,
      error: `git add in the worktree failed: ${(add.stderr || add.stdout).trim().slice(0, 300)}`,
    }
  }
  const patchPath = join(worktreesRoot(cwd), `${entry.id}.patch`)
  const diff = await runCommand(`git diff --cached --binary ${base} > "${patchPath}"`, {
    cwd: entry.path,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (diff.exitCode !== 0 || diff.timedOut) {
    return {
      ok: false,
      error: `git diff in the worktree failed: ${(diff.stderr || diff.stdout).trim().slice(0, 300)}`,
    }
  }
  let patch = ""
  try {
    patch = readFileSync(patchPath, "utf8")
  } catch {
    // treated as empty below
  }
  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1] as string)
  if (patch.trim() === "") {
    const removed = await removeWorktree(cwd, entry.path)
    if (removed.ok) rmSync(metaPath(cwd, entry.id), { force: true })
    return { ok: true, files: [], patchPath, removed: removed.ok }
  }
  const check = await runCommand(`git apply --check --whitespace=nowarn "${patchPath}"`, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (check.exitCode !== 0 || check.timedOut) {
    return {
      ok: false,
      conflict: true,
      error: `the worktree's changes do not apply cleanly to the main tree (nothing was changed; worktree kept at ${entry.path}):\n${(check.stderr || check.stdout).trim().slice(0, 600)}`,
    }
  }
  const apply = await runCommand(`git apply --whitespace=nowarn "${patchPath}"`, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (apply.exitCode !== 0 || apply.timedOut) {
    return {
      ok: false,
      error: `git apply failed: ${(apply.stderr || apply.stdout).trim().slice(0, 600)}`,
    }
  }
  const removed = await removeWorktree(cwd, entry.path)
  if (removed.ok) rmSync(metaPath(cwd, entry.id), { force: true })
  return { ok: true, files, patchPath, removed: removed.ok }
}

/** Throw a worktree's work away. */
export async function discardWorktree(cwd: string, ref: string): Promise<RemoveWorktreeResult> {
  const entry = findWorktree(cwd, ref)
  if (!entry) return { ok: false, error: `no isolated worktree matches "${ref}"` }
  const removed = await removeWorktree(cwd, entry.path)
  if (removed.ok) rmSync(metaPath(cwd, entry.id), { force: true })
  return removed
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
  rmSync(`${path}.json`, { force: true })
  return { ok: true }
}
