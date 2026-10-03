import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_IGNORED_SEGMENTS } from "../tool/tools/glob"
import type { GraphDb } from "./db"
import { languageForPath } from "./languages"
import { scanFile } from "./scan"

export interface SyncResult {
  scanned: number
  skipped: number
  removed: number
}

/** Files above this are generated/minified bundles far more often than hand-written source. */
export const MAX_INDEXED_FILE_BYTES = 512 * 1024
/** Hard ceiling so a monorepo checkout can't turn the first sync into minutes. */
export const MAX_INDEXED_FILES = 20_000

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(text)
  return hasher.digest("hex")
}

export function listSourceFiles(cwd: string): string[] {
  const keep = (rel: string) =>
    !DEFAULT_IGNORED_SEGMENTS.some((segment) => rel.split("/").includes(segment)) &&
    languageForPath(rel) !== undefined

  if (existsSync(join(cwd, ".git"))) {
    try {
      const result = Bun.spawnSync(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { cwd, stdout: "pipe", stderr: "ignore", timeout: 15_000 },
      )
      if (result.exitCode === 0) {
        const files = result.stdout
          .toString()
          .split("\0")
          .filter((rel) => rel !== "")
          .map((rel) => rel.replaceAll("\\", "/"))
          .filter(keep)
        return [...new Set(files)].sort()
      }
    } catch {
      // git missing or hung — glob below
    }
  }

  const files: string[] = []
  const glob = new Bun.Glob("**/*")
  for (const entry of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
    const rel = entry.replaceAll("\\", "/")
    if (keep(rel)) files.push(rel)
  }
  return files.sort()
}

export async function syncRepo(cwd: string, db: GraphDb): Promise<SyncResult> {
  const seen = new Set<string>()
  let scanned = 0
  let skipped = 0

  for (const rel of listSourceFiles(cwd).slice(0, MAX_INDEXED_FILES)) {
    let stat: { mtime: number; size: number }
    try {
      const st = statSync(join(cwd, rel))
      if (!st.isFile()) continue
      stat = { mtime: st.mtimeMs, size: st.size }
    } catch {
      continue
    }
    if (stat.size > MAX_INDEXED_FILE_BYTES) continue
    seen.add(rel)

    const known = db.fileStat(rel)
    // "Racy clean" guard (git's own rule): a file touched within the last
    // couple of seconds could be rewritten again inside the same mtime tick
    // with the same size, so recent files always go to the hash check.
    const racy = Date.now() - stat.mtime < 2_000
    if (known && !racy && known.mtime === stat.mtime && known.size === stat.size) {
      skipped += 1
      continue
    }

    let source: string
    try {
      source = readFileSync(join(cwd, rel), "utf8")
    } catch {
      seen.delete(rel)
      continue
    }

    const hash = sha256(source)
    if (db.fileHash(rel) === hash) {
      db.touchStat(rel, stat)
      skipped += 1
      continue
    }
    const tags = await scanFile(rel, source)
    if (!tags) continue
    db.upsertFile(rel, hash, tags, stat)
    scanned += 1
  }

  let removed = 0
  for (const known of db.allFiles()) {
    if (!seen.has(known)) {
      db.removeFile(known)
      removed += 1
    }
  }

  if (scanned > 0 || removed > 0) db.setMeta("lastSync", String(Date.now()))
  return { scanned, skipped, removed }
}
