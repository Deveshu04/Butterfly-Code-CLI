import { readFileSync } from "node:fs"
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

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(text)
  return hasher.digest("hex")
}

export async function syncRepo(cwd: string, db: GraphDb): Promise<SyncResult> {
  const glob = new Bun.Glob("**/*")
  const seen = new Set<string>()
  let scanned = 0
  let skipped = 0

  for (const entry of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
    const rel = entry.replaceAll("\\", "/")
    if (DEFAULT_IGNORED_SEGMENTS.some((segment) => rel.split("/").includes(segment))) continue
    if (!languageForPath(rel)) continue

    let source: string
    try {
      source = readFileSync(join(cwd, rel), "utf8")
    } catch {
      continue
    }
    seen.add(rel)

    const hash = sha256(source)
    if (db.fileHash(rel) === hash) {
      skipped += 1
      continue
    }
    const tags = await scanFile(rel, source)
    if (!tags) continue
    db.upsertFile(rel, hash, tags)
    scanned += 1
  }

  let removed = 0
  for (const known of db.allFiles()) {
    if (!seen.has(known)) {
      db.removeFile(known)
      removed += 1
    }
  }

  return { scanned, skipped, removed }
}
