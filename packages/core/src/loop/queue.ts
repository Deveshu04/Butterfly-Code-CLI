import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"


export type TaskStatus = "open" | "claimed" | "closed" | "blocked"

export interface LoopTask {
  id: string
  title: string
  spec: string
  status: TaskStatus
  attempts: number
  lastFailure?: string
}

export const MAX_ATTEMPTS = 3

interface TaskRow {
  id: string
  title: string
  spec: string
  status: TaskStatus
  attempts: number
  lastFailure: string | null
}

function toTask(row: TaskRow): LoopTask {
  return {
    id: row.id,
    title: row.title,
    spec: row.spec,
    status: row.status,
    attempts: row.attempts,
    lastFailure: row.lastFailure ?? undefined,
  }
}

export class WorkQueue {
  private constructor(private db: Database) {}

  static open(path: string): WorkQueue {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1')")
    db.run(
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        spec TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        attempts INTEGER NOT NULL DEFAULT 0,
        lastFailure TEXT
      )`,
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS edges (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL)",
    )
    // Crash recovery: a claim from a dead process must not strand the task.
    db.run("UPDATE tasks SET status = 'open' WHERE status = 'claimed'")
    return new WorkQueue(db)
  }

  addTask(input: { title: string; spec: string; blockedBy?: string[] }): string {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(`${input.title}\n${input.spec}`)
    const id = `bt-${hasher.digest("hex").slice(0, 8)}`
    this.db.run("INSERT OR IGNORE INTO tasks (id, title, spec) VALUES (?, ?, ?)", [
      id,
      input.title,
      input.spec,
    ])
    for (const blocker of input.blockedBy ?? []) {
      this.db.run("INSERT INTO edges (src, dst, kind) VALUES (?, ?, 'blocks')", [blocker, id])
    }
    return id
  }

  /** Open tasks whose blockers are all closed. */
  ready(): LoopTask[] {
    const rows = this.db
      .query(
        `SELECT t.id, t.title, t.spec, t.status, t.attempts, t.lastFailure FROM tasks t
         WHERE t.status = 'open' AND NOT EXISTS (
           SELECT 1 FROM edges e JOIN tasks b ON b.id = e.src
           WHERE e.dst = t.id AND e.kind = 'blocks' AND b.status != 'closed'
         )
         ORDER BY t.rowid`,
      )
      .all() as TaskRow[]
    return rows.map(toTask)
  }

  /** Atomic open→claimed; returns false if someone else won. */
  claim(id: string): boolean {
    const result = this.db.run(
      "UPDATE tasks SET status = 'claimed' WHERE id = ? AND status = 'open'",
      [id],
    )
    return result.changes > 0
  }

  close(id: string): void {
    this.db.run("UPDATE tasks SET status = 'closed' WHERE id = ?", [id])
  }

  /** Failed attempt: requeue with feedback, or block at the attempt cap. */
  release(id: string, failure: string): void {
    const task = this.get(id)
    if (!task) return
    const attempts = task.attempts + 1
    const status: TaskStatus = attempts >= MAX_ATTEMPTS ? "blocked" : "open"
    this.db.run("UPDATE tasks SET status = ?, attempts = ?, lastFailure = ? WHERE id = ?", [
      status,
      attempts,
      failure,
      id,
    ])
  }

  get(id: string): LoopTask | undefined {
    const row = this.db
      .query("SELECT id, title, spec, status, attempts, lastFailure FROM tasks WHERE id = ?")
      .get(id) as TaskRow | null
    return row ? toTask(row) : undefined
  }

  counts(): Record<TaskStatus, number> {
    const rows = this.db.query("SELECT status, COUNT(*) as n FROM tasks GROUP BY status").all() as {
      status: TaskStatus
      n: number
    }[]
    const counts: Record<TaskStatus, number> = { open: 0, claimed: 0, closed: 0, blocked: 0 }
    for (const row of rows) counts[row.status] = row.n
    return counts
  }

  closeDb(): void {
    this.db.close()
  }
}
