import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Tag } from "./scan"

export interface DefRow {
  file: string
  name: string
  symbolKind: string
  row: number
  endRow: number
}

export interface FileStat {
  mtime: number
  size: number
}

export interface GraphStats {
  files: number
  symbols: number
  refs: number
  lastSync?: number
}

/** file → file dependency: `from` references `weight` symbols defined in `to`. */
export interface FileEdge {
  from: string
  to: string
  weight: number
}

export interface RefRow {
  file: string
  name: string
  count: number
}

/**
 * Derived, rebuildable code graph: files(path, sha256) + symbols(defs) +
 * refs(name usage per file).
 */
export class GraphDb {
  private constructor(private db: Database) {}

  static open(path: string): GraphDb {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL)")
    db.run(
      "CREATE TABLE IF NOT EXISTS symbols (file TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, row INTEGER NOT NULL, endRow INTEGER NOT NULL)",
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS refs (file TEXT NOT NULL, name TEXT NOT NULL, count INTEGER NOT NULL)",
    )
    db.run("CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)")
    db.run("CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file)")
    db.run("CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name)")
    db.run("CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file)")
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    // v2: mtime/size columns let an unchanged stat skip the read and hash.
    const columns = (db.query("PRAGMA table_info(files)").all() as { name: string }[]).map(
      (c) => c.name,
    )
    if (!columns.includes("mtime")) db.run("ALTER TABLE files ADD COLUMN mtime REAL")
    if (!columns.includes("size")) db.run("ALTER TABLE files ADD COLUMN size INTEGER")
    return new GraphDb(db)
  }

  upsertFile(path: string, sha256: string, tags: Tag[], stat?: FileStat): void {
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM symbols WHERE file = ?", [path])
      this.db.run("DELETE FROM refs WHERE file = ?", [path])
      this.db.run("INSERT OR REPLACE INTO files (path, sha256, mtime, size) VALUES (?, ?, ?, ?)", [
        path,
        sha256,
        stat?.mtime ?? null,
        stat?.size ?? null,
      ])

      const refCounts = new Map<string, number>()
      for (const tag of tags) {
        if (tag.kind === "def") {
          this.db.run(
            "INSERT INTO symbols (file, name, kind, row, endRow) VALUES (?, ?, ?, ?, ?)",
            [path, tag.name, tag.symbolKind, tag.row, tag.endRow],
          )
        } else {
          refCounts.set(tag.name, (refCounts.get(tag.name) ?? 0) + 1)
        }
      }
      for (const [name, count] of refCounts) {
        this.db.run("INSERT INTO refs (file, name, count) VALUES (?, ?, ?)", [path, name, count])
      }
    })
    tx()
  }

  removeFile(path: string): void {
    this.db.run("DELETE FROM symbols WHERE file = ?", [path])
    this.db.run("DELETE FROM refs WHERE file = ?", [path])
    this.db.run("DELETE FROM files WHERE path = ?", [path])
  }

  fileHash(path: string): string | undefined {
    const row = this.db.query("SELECT sha256 FROM files WHERE path = ?").get(path) as {
      sha256: string
    } | null
    return row?.sha256
  }

  fileStat(path: string): FileStat | undefined {
    const row = this.db.query("SELECT mtime, size FROM files WHERE path = ?").get(path) as {
      mtime: number | null
      size: number | null
    } | null
    if (!row || row.mtime === null || row.size === null) return undefined
    return { mtime: row.mtime, size: row.size }
  }

  /** Content unchanged (same hash) but the stat moved — record it so the next sync stays on the fast path. */
  touchStat(path: string, stat: FileStat): void {
    this.db.run("UPDATE files SET mtime = ?, size = ? WHERE path = ?", [
      stat.mtime,
      stat.size,
      path,
    ])
  }

  setMeta(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, value])
  }

  getMeta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string
    } | null
    return row?.value
  }

  stats(): GraphStats {
    const count = (sql: string) => (this.db.query(sql).get() as { n: number }).n
    const last = Number(this.getMeta("lastSync"))
    return {
      files: count("SELECT COUNT(*) AS n FROM files"),
      symbols: count("SELECT COUNT(*) AS n FROM symbols"),
      refs: count("SELECT COUNT(*) AS n FROM refs"),
      ...(Number.isFinite(last) && last > 0 ? { lastSync: last } : {}),
    }
  }

  /** Definitions in one file, in source order — the cheap alternative to reading it. */
  fileDefs(path: string): DefRow[] {
    const rows = this.db
      .query(
        "SELECT file, name, kind as symbolKind, row, endRow FROM symbols WHERE file = ? ORDER BY row",
      )
      .all(path) as DefRow[]
    // One row per name+line, in case a query captures a node under two kinds.
    const seen = new Set<string>()
    return rows.filter((row) => {
      const key = `${row.name}:${row.row}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /** Indexed paths matching a path fragment (exact first, then suffix, then substring). */
  findFiles(fragment: string): string[] {
    const needle = fragment.replaceAll("\\", "/").replace(/^\.\//, "")
    const exact = this.db.query("SELECT path FROM files WHERE path = ?").get(needle) as {
      path: string
    } | null
    if (exact) return [exact.path]
    const rows = this.db
      .query("SELECT path FROM files WHERE path LIKE ? ORDER BY length(path), path LIMIT 20")
      .all(`%${needle}%`) as { path: string }[]
    const suffix = rows.filter((r) => r.path.endsWith(`/${needle}`) || r.path.endsWith(needle))
    return (suffix.length > 0 ? suffix : rows).map((r) => r.path)
  }

  /** Files referencing `name` (excluding its definers), heaviest first — indexed, no full scan. */
  callers(name: string): RefRow[] {
    return this.db
      .query(
        "SELECT file, name, count FROM refs WHERE name = ? AND file NOT IN (SELECT file FROM symbols WHERE name = ?) ORDER BY count DESC, file",
      )
      .all(name, name) as RefRow[]
  }

  /**
   * File-level dependency edges derived from symbol references. Names
   * defined in more than `maxDefiners` files ("get", "run", "init") carry
   * no real dependency signal and are skipped — otherwise every file
   * "depends on" every other one.
   */
  fileEdges(maxDefiners = 3): FileEdge[] {
    return this.db
      .query(
        // Short or all-lowercase names collide with locals everywhere, so definers
        // are restricted to specific-looking names (camel/Pascal/snake, or >= 8
        // chars) outside test files.
        `WITH definers AS (
           SELECT name, file FROM symbols
           WHERE name IN (SELECT name FROM symbols GROUP BY name HAVING COUNT(DISTINCT file) <= ?)
             AND length(name) >= 4
             AND (name GLOB '*[A-Z_]*' OR length(name) >= 8)
             AND file NOT GLOB '*.test.*' AND file NOT GLOB '*.spec.*'
             AND file NOT GLOB 'test/*' AND file NOT GLOB '*/test/*'
             AND file NOT GLOB 'tests/*' AND file NOT GLOB '*/tests/*'
             AND file NOT GLOB '*/__tests__/*'
           GROUP BY name, file
         )
         SELECT r.file AS "from", d.file AS "to", SUM(r.count) AS weight
         FROM refs r JOIN definers d ON d.name = r.name
         WHERE r.file != d.file
         GROUP BY r.file, d.file
         ORDER BY weight DESC`,
      )
      .all(maxDefiners) as FileEdge[]
  }

  allFiles(): string[] {
    const rows = this.db.query("SELECT path FROM files ORDER BY path").all() as { path: string }[]
    return rows.map((r) => r.path)
  }

  defs(): DefRow[] {
    return this.db
      .query("SELECT file, name, kind as symbolKind, row, endRow FROM symbols ORDER BY file, row")
      .all() as DefRow[]
  }

  refs(): RefRow[] {
    return this.db.query("SELECT file, name, count FROM refs ORDER BY file, name").all() as RefRow[]
  }

  lookupDefs(name: string): DefRow[] {
    return this.db
      .query("SELECT file, name, kind as symbolKind, row, endRow FROM symbols WHERE name = ?")
      .all(name) as DefRow[]
  }

  searchDefs(substring: string): DefRow[] {
    return this.db
      .query(
        "SELECT file, name, kind as symbolKind, row, endRow FROM symbols WHERE name LIKE ? LIMIT 50",
      )
      .all(`%${substring}%`) as DefRow[]
  }

  close(): void {
    this.db.close()
  }
}
