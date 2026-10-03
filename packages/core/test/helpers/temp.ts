import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isGitRepo } from "../../src/session/snapshot"

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
