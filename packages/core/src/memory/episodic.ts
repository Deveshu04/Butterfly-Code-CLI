import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SessionJournal } from "../session/journal"

/** Episodic memory: SQLite FTS5 over raw journal events, zero standing tokens. */

export interface EpisodicHit {
  sessionId: string
  time: string
  type: string
  text: string
}

export class EpisodicIndex {
  private constructor(private db: Database) {}

  static open(path: string): EpisodicIndex {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS episodes USING fts5(sessionId, time, type, text)")
    db.run(
      "CREATE TABLE IF NOT EXISTS indexed_journals (path TEXT PRIMARY KEY, eventCount INTEGER NOT NULL)",
    )
    return new EpisodicIndex(db)
  }

  /** Index new events from a journal file (incremental — no duplicates). */
  indexJournal(journalPath: string): number {
    const { header, events } = SessionJournal.replay(journalPath)
    const row = this.db
      .query("SELECT eventCount FROM indexed_journals WHERE path = ?")
      .get(journalPath) as { eventCount: number } | null
    const already = row?.eventCount ?? 0
    const fresh = events.slice(already)

    let added = 0
    const tx = this.db.transaction(() => {
      for (const event of fresh) {
        let text: string | undefined
        if (event.type === "message.user" || event.type === "message.assistant") text = event.text
        else if (event.type === "tool.result") text = event.output
        else if (event.type === "tool.call") text = `${event.name} ${JSON.stringify(event.input)}`
        if (!text || text.trim() === "") continue
        this.db.run("INSERT INTO episodes (sessionId, time, type, text) VALUES (?, ?, ?, ?)", [
          header.sessionId,
          event.time,
          event.type,
          text,
        ])
        added += 1
      }
      this.db.run("INSERT OR REPLACE INTO indexed_journals (path, eventCount) VALUES (?, ?)", [
        journalPath,
        events.length,
      ])
    })
    tx()
    return added
  }

  search(query: string, limit = 10): EpisodicHit[] {
    // FTS5 MATCH with each term quoted (user text is not FTS syntax).
    const sanitized = query
      .split(/\s+/)
      .filter((term) => term !== "")
      .map((term) => `"${term.replaceAll('"', "")}"`)
      .join(" ")
    if (sanitized === "") return []
    return this.db
      .query(
        "SELECT sessionId, time, type, text FROM episodes WHERE episodes MATCH ? ORDER BY bm25(episodes) LIMIT ?",
      )
      .all(sanitized, limit) as EpisodicHit[]
  }

  close(): void {
    this.db.close()
  }
}
