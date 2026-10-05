import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { runCommand } from "../tool/shell"

export const GIT_TIMEOUT_MS = 15_000

/** Filesystem-only repo detection; `git rev-parse` can hang for minutes on
 * some Windows setups outside a repo. */
export function isGitRepo(cwd: string): boolean {
  let dir = cwd
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
  return false
}

/**
 * Turn-level file snapshots for /undo: a temporary git index captures the
 * worktree as a tree object, so the user's staging area is untouched and no
 * commits are made. Restore checks the tree back out.
 */

function tempIndexEnv(cwd: string): Record<string, string> {
  mkdirSync(join(cwd, ".butterfly"), { recursive: true })
  return { GIT_INDEX_FILE: join(cwd, ".butterfly", "undo-index") }
}

/** Tree hash of the current worktree, or null when not a git repo. */
export async function createSnapshot(cwd: string): Promise<string | null> {
  if (!isGitRepo(cwd)) return null

  const env = tempIndexEnv(cwd)
  const add = await runCommand("git add -A", { cwd, env, timeoutMs: GIT_TIMEOUT_MS })
  if (add.exitCode !== 0 || add.timedOut) return null
  const tree = await runCommand("git write-tree", { cwd, env, timeoutMs: GIT_TIMEOUT_MS })
  if (tree.exitCode !== 0 || tree.timedOut) return null
  const hash = tree.stdout.trim()
  return /^[0-9a-f]{40,64}$/.test(hash) ? hash : null
}

/**
 * Untracked paths relative to cwd, read from the real repo index. Uses `-z`
 * because the default format C-quotes non-ASCII and special paths, which
 * would not match real files.
 */
export async function listUntracked(cwd: string): Promise<string[]> {
  if (!isGitRepo(cwd)) return []
  const status = await runCommand("git status --porcelain -z --untracked-files=all", {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (status.exitCode !== 0 || status.timedOut) return []
  return status.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3))
    .filter((path) => path !== "")
}

/**
 * Restore the worktree files recorded in a snapshot tree. With
 * `opts.untracked`, files untracked now but not in that baseline were created
 * after the snapshot and are deleted; without it nothing is deleted.
 */
export async function restoreSnapshot(
  cwd: string,
  tree: string,
  opts?: { untracked?: string[] },
): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(tree) || !isGitRepo(cwd)) return false
  const env = tempIndexEnv(cwd)
  const read = await runCommand(`git read-tree ${tree}`, { cwd, env, timeoutMs: GIT_TIMEOUT_MS })
  if (read.exitCode !== 0) return false
  const checkout = await runCommand("git checkout-index -a -f", {
    cwd,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (checkout.exitCode !== 0) return false

  if (opts?.untracked !== undefined) {
    const baseline = new Set(opts.untracked)
    const current = await listUntracked(cwd)
    for (const path of current) {
      if (baseline.has(path)) continue
      try {
        rmSync(join(cwd, path), { force: true, recursive: true })
      } catch {
        // best-effort; never fail the restore over a stray file
      }
    }
  }
  return true
}
