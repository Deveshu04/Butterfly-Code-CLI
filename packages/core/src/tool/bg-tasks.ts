import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { now, type SessionEvent } from "../session/events"
import { killTree, resolveShell } from "./shell"


export const BG_TASKS_STATE_KEY = "bgTasks"

export const BG_LOG_CAP_BYTES = 200_000

function truncationNotice(capBytes: number): string {
  return `\n[... output truncated: background task log capped at ${capBytes} bytes ...]\n`
}

export interface BgTaskJournalSink {
  append(event: SessionEvent): void
}

export type BgTaskStatus = "running" | "exited" | "killed"

export interface BgTaskRecord {
  id: string
  command: string
  pid: number
  status: BgTaskStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  logPath: string
  keepAlive: boolean
}

export interface BgTaskRegistryOptions {
  cwd: string
  logDir: string
  journal?: BgTaskJournalSink
  logCapBytes?: number
  onEnd?: (record: BgTaskRecord) => void
}

interface RunningEntry {
  record: BgTaskRecord
  proc: ReturnType<typeof Bun.spawn>
  bytesWritten: number
}

export class BgTaskRegistry {
  private running = new Map<string, RunningEntry>()
  private finished = new Map<string, BgTaskRecord>()
  private readonly capBytes: number

  constructor(private opts: BgTaskRegistryOptions) {
    this.capBytes = opts.logCapBytes ?? BG_LOG_CAP_BYTES
  }

  private freshId(): string {
    let id = crypto.randomUUID().slice(0, 8)
    while (this.running.has(id) || this.finished.has(id)) {
      id = crypto.randomUUID().slice(0, 8)
    }
    return id
  }

  spawn(command: string, spawnOpts: { keepAlive?: boolean } = {}): BgTaskRecord {
    mkdirSync(this.opts.logDir, { recursive: true })
    const id = this.freshId()
    const logPath = join(this.opts.logDir, `${id}.log`)
    writeFileSync(logPath, "")

    const { exe, args } = resolveShell()
    const proc = Bun.spawn([exe, ...args(command)], {
      cwd: this.opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        TQDM_DISABLE: "1",
        NO_COLOR: "1",
      },
    })

    const record: BgTaskRecord = {
      id,
      command,
      pid: proc.pid,
      status: "running",
      startedAt: now(),
      logPath,
      keepAlive: spawnOpts.keepAlive === true,
    }
    const entry: RunningEntry = { record, proc, bytesWritten: 0 }
    this.running.set(id, entry)

    void this.pumpOutput(entry, proc.stdout)
    void this.pumpOutput(entry, proc.stderr)
    void this.awaitExit(entry)

    this.opts.journal?.append({
      type: "bgtask.start",
      id,
      command,
      pid: proc.pid,
      logPath,
      keepAlive: record.keepAlive,
      time: now(),
    })

    return record
  }

  private async pumpOutput(
    entry: RunningEntry,
    stream: ReadableStream<Uint8Array> | number | undefined,
  ): Promise<void> {
    if (!stream || typeof stream === "number") return
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length > 0) this.appendLog(entry, value)
      }
    } catch {
    }
  }

  private appendLog(entry: RunningEntry, chunk: Uint8Array): void {
    if (entry.bytesWritten >= this.capBytes) return
    const remaining = this.capBytes - entry.bytesWritten
    const overflow = chunk.length > remaining
    const slice = overflow ? chunk.subarray(0, remaining) : chunk
    appendFileSync(entry.record.logPath, slice)
    entry.bytesWritten += slice.length
    if (overflow) appendFileSync(entry.record.logPath, truncationNotice(this.capBytes))
  }

  private async awaitExit(entry: RunningEntry): Promise<void> {
    const exitCode = await entry.proc.exited
    if (!this.running.has(entry.record.id)) return
    this.finish(entry.record.id, "exited", exitCode)
  }

  private finish(id: string, status: "exited" | "killed", exitCode?: number): void {
    const entry = this.running.get(id)
    if (!entry) return
    this.running.delete(id)
    const record: BgTaskRecord = {
      ...entry.record,
      status,
      endedAt: now(),
      ...(exitCode !== undefined ? { exitCode } : {}),
    }
    this.finished.set(id, record)
    this.opts.journal?.append({
      type: "bgtask.end",
      id,
      status,
      ...(exitCode !== undefined ? { exitCode } : {}),
      time: now(),
    })
    this.opts.onEnd?.(record)
  }

  list(): BgTaskRecord[] {
    return [...[...this.running.values()].map((e) => e.record), ...this.finished.values()].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt),
    )
  }

  get(id: string): BgTaskRecord | undefined {
    return this.running.get(id)?.record ?? this.finished.get(id)
  }

  kill(id: string): boolean {
    const entry = this.running.get(id)
    if (!entry) return false
    killTree(entry.proc)
    this.finish(id, "killed")
    return true
  }

  tail(id: string, maxChars = 2_000): string | undefined {
    const record = this.get(id)
    if (!record) return undefined
    try {
      const text = readFileSync(record.logPath, "utf8")
      return text.length > maxChars ? text.slice(-maxChars) : text
    } catch {
      return ""
    }
  }

  reap(): string[] {
    const killed: string[] = []
    for (const [id, entry] of [...this.running]) {
      if (entry.record.keepAlive) continue
      killTree(entry.proc)
      this.finish(id, "killed")
      killed.push(id)
    }
    return killed
  }
}
