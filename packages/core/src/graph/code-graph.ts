import { existsSync } from "node:fs"
import { join } from "node:path"
import { GraphDb } from "./db"
import { PROJECT_MAP_FILE, writeProjectMap } from "./project-map"
import { type SyncResult, syncRepo } from "./sync"

export class CodeGraph {
  private inflight: Promise<SyncResult> | undefined
  private lastSyncAt = 0
  /** True once the first sync has completed (explore answers from then on). */
  ready = false
  lastResult: SyncResult | undefined
  lastError: string | undefined

  private constructor(
    readonly cwd: string,
    readonly db: GraphDb,
    private readonly now: () => number,
  ) {}

  static open(cwd: string, opts?: { now?: () => number; dbPath?: string }): CodeGraph {
    const db = GraphDb.open(opts?.dbPath ?? join(cwd, ".butterfly", "graph.db"))
    return new CodeGraph(cwd, db, opts?.now ?? Date.now)
  }

  /** When the last sync finished (in memory — no-op syncs write nothing to disk). */
  get lastSyncTime(): number | undefined {
    return this.lastSyncAt > 0 ? this.lastSyncAt : undefined
  }

  get mapPath(): string {
    return join(this.cwd, ".butterfly", PROJECT_MAP_FILE)
  }

  sync(opts?: { forceMap?: boolean }): Promise<SyncResult> {
    if (this.inflight) return this.inflight
    const run = (async () => {
      try {
        const result = await syncRepo(this.cwd, this.db)
        this.lastResult = result
        this.lastError = undefined
        const changed = result.scanned > 0 || result.removed > 0
        if (changed || opts?.forceMap || !existsSync(this.mapPath)) {
          try {
            writeProjectMap(this.cwd, this.db)
          } catch {
            // read-only checkout: the index still works, only the view is missing
          }
        }
        this.ready = true
        return result
      } catch (error) {
        this.lastError = String(error)
        throw error
      } finally {
        this.lastSyncAt = this.now()
        this.inflight = undefined
      }
    })()
    this.inflight = run
    return run
  }

  /** Re-sync when the last one is older than `minIntervalMs`; never throws. */
  async fresh(minIntervalMs = 1_500): Promise<void> {
    if (this.inflight) {
      await this.inflight.catch(() => {})
      return
    }
    if (this.ready && this.now() - this.lastSyncAt < minIntervalMs) return
    await this.sync().catch(() => {})
  }

  close(): void {
    this.db.close()
  }
}
