import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { now, type SessionEvent } from "../session/events"
import { killTree, resolveShell, type ShellFamily, type ShellResolution } from "./shell"


export const BG_TASKS_STATE_KEY = "bgTasks"

/** Env var carrying the log path into the spawned shell — see wrapBackgroundCommand. */
export const BG_LOG_ENV = "BUTTERFLY_BG_LOG"

export const BG_LOG_CAP_BYTES = 200_000

/** How often a running task's log is size-checked against the cap. */
export const BG_LOG_CHECK_INTERVAL_MS = 2_000

function truncationNotice(capBytes: number): string {
  return `[... earlier output truncated: background task log rolled at ${capBytes} bytes ...]\n`
}

export function wrapBackgroundCommand(family: ShellFamily, command: string): string | undefined {
  if (family !== "posix") return undefined
  return `exec >>"$${BG_LOG_ENV}" 2>&1\n${command}`
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
  logCheckIntervalMs?: number
  shell?: () => ShellResolution
  onEnd?: (record: BgTaskRecord) => void
}

interface RunningEntry {
  record: BgTaskRecord
  proc: ReturnType<typeof Bun.spawn>
}

const enrolled = new Set<BgTaskRegistry>()
let exitHookInstalled = false

function enrol(registry: BgTaskRegistry): void {
  enrolled.add(registry)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on("exit", () => {
    reapAllBackgroundTasks()
  })
}

function unenrol(registry: BgTaskRegistry): void {
  enrolled.delete(registry)
}

/**
 * Reap every registry in this process (kills running, non-keepAlive tasks).
 * Idempotent and never throws — safe from crash handlers and exit hooks.
 * Returns the ids killed.
 */
export function reapAllBackgroundTasks(): string[] {
  const killed: string[] = []
  for (const registry of [...enrolled]) {
    try {
      killed.push(...registry.reap())
    } catch {
      // a failing reap must never mask the real exit/crash reason
    }
  }
  return killed
}

export class BgTaskRegistry {
  private running = new Map<string, RunningEntry>()
  private finished = new Map<string, BgTaskRecord>()
  private readonly capBytes: number
  private readonly checkIntervalMs: number
  private capTimer: ReturnType<typeof setInterval> | undefined

  constructor(private opts: BgTaskRegistryOptions) {
    this.capBytes = opts.logCapBytes ?? BG_LOG_CAP_BYTES
    this.checkIntervalMs = opts.logCheckIntervalMs ?? BG_LOG_CHECK_INTERVAL_MS
  }

  private freshId(): string {
    let id = crypto.randomUUID().slice(0, 8)
    while (this.running.has(id) || this.finished.has(id)) {
      id = crypto.randomUUID().slice(0, 8)
    }
    return id
  }

  spawn(command: string, spawnOpts: { keepAlive?: boolean } = {}): BgTaskRecord {
    const shell = (this.opts.shell ?? resolveShell)()
    const wrapped = wrapBackgroundCommand(shell.family, command)
    if (wrapped === undefined) {
      throw new Error(
        `Background tasks need a POSIX shell (bash/sh); the shell resolved here is ${shell.exe}. ` +
          "Install Git for Windows (or point BUTTERFLY_GIT_BASH_PATH at a bash.exe) and retry, " +
          "or run the command in the foreground instead.",
      )
    }

    mkdirSync(this.opts.logDir, { recursive: true })
    const id = this.freshId()
    const logPath = join(this.opts.logDir, `${id}.log`)
    writeFileSync(logPath, "")

    const proc = Bun.spawn([shell.exe, ...shell.args(wrapped)], {
      cwd: this.opts.cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        [BG_LOG_ENV]: logPath,
        PAGER: "cat",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        TQDM_DISABLE: "1",
        NO_COLOR: "1",
      },
    })
    proc.unref()

    const record: BgTaskRecord = {
      id,
      command,
      pid: proc.pid,
      status: "running",
      startedAt: now(),
      logPath,
      keepAlive: spawnOpts.keepAlive === true,
    }
    this.running.set(id, { record, proc })
    enrol(this)
    this.startCapWatch()

    void this.awaitExit(id, proc)

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

  private startCapWatch(): void {
    if (this.capTimer !== undefined) return
    const timer = setInterval(() => this.enforceCaps(), this.checkIntervalMs)
    timer.unref?.()
    this.capTimer = timer
  }

  private stopCapWatchIfIdle(): void {
    if (this.running.size > 0 || this.capTimer === undefined) return
    clearInterval(this.capTimer)
    this.capTimer = undefined
  }

  private enforceCaps(): void {
    for (const entry of this.running.values()) this.enforceCap(entry.record.logPath)
  }

  private enforceCap(logPath: string): void {
    let size: number
    try {
      size = statSync(logPath).size
    } catch {
      return // log not created yet / already removed
    }
    if (size <= this.capBytes) return
    const keep = Math.max(1, Math.floor(this.capBytes / 2))
    try {
      const tailBytes = readTailBytes(logPath, keep)
      writeFileSync(logPath, `${truncationNotice(this.capBytes)}${tailBytes.toString("utf8")}`)
    } catch {
      // an unreadable/locked log is never worth failing a session over
    }
  }

  private async awaitExit(id: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const exitCode = await proc.exited
    if (!this.running.has(id)) return
    this.finish(id, "exited", exitCode)
  }

  private finish(id: string, status: "exited" | "killed", exitCode?: number): void {
    const entry = this.running.get(id)
    if (!entry) return
    this.running.delete(id)
    this.enforceCap(entry.record.logPath)
    this.stopCapWatchIfIdle()
    if (this.running.size === 0) unenrol(this)
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
      const text = readTailBytes(record.logPath, maxChars * 4).toString("utf8")
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

function readTailBytes(path: string, maxBytes: number): Buffer {
  const size = statSync(path).size
  if (size === 0) return Buffer.alloc(0)
  const length = Math.min(size, maxBytes)
  const fd = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    return buffer
  } finally {
    closeSync(fd)
  }
}
