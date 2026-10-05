import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isGitRepo } from "../../src/session/snapshot"

/**
 * A directory guaranteed not to be inside a git repo (isGitRepo() walks up
 * for `.git`, and some home directories are git-tracked). Prefers the per-run
 * test sandbox; if an ancestor `.git` rules that out, falls back to the drive
 * root and registers the directory for removal at exit.
 */
export function nonRepoDir(prefix: string): string {
  const candidate = mkdtempSync(join(tmpdir(), prefix))
  if (!isGitRepo(candidate)) return candidate
  rmSync(candidate, { recursive: true, force: true })
  const root = process.platform === "win32" ? `${process.cwd().slice(0, 2)}\\` : "/"
  try {
    const dir = mkdtempSync(join(root, prefix))
    ;(globalThis as { __bflyTestCleanup?: Set<string> }).__bflyTestCleanup?.add(dir)
    return dir
  } catch {
    return mkdtempSync(join(tmpdir(), prefix))
  }
}
