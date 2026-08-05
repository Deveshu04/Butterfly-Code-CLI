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

export interface RefRow {
  file: string
  name: string
  count: number
}

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
    return new GraphDb(db)
  }

  upsertFile(path: string, sha256: string, tags: Tag[]): void {
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM symbols WHERE file = ?", [path])
      this.db.run("DELETE FROM refs WHERE file = ?", [path])
      this.db.run("INSERT OR REPLACE INTO files (path, sha256) VALUES (?, ?)", [path, sha256])

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
