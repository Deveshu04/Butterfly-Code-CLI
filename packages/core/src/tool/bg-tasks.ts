import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { now, type SessionEvent } from "../session/events"
import { killTree, resolveShell, type ShellFamily, type ShellResolution } from "./shell"

/**
 * Background bash task registry (one per session, in ToolContext.state under
 * BG_TASKS_STATE_KEY). Tasks spawn detached with no pipes, since a pipe's read
 * end dies with the parent; the shell redirects its own output to a capped
 * log whose path travels in an env var. Windows without Git Bash is refused:
 * detached PowerShell logs nothing and cmd mangles the redirect. In-memory
 * state is the source of truth; the journal is a best-effort audit trail.
 */

export const BG_TASKS_STATE_KEY = "bgTasks"

/** Env var carrying the log path into the spawned shell — see wrapBackgroundCommand. */
export const BG_LOG_ENV = "BUTTERFLY_BG_LOG"

/** On-disk cap; only a ~2k-char tail ever reaches the model. */
export const BG_LOG_CAP_BYTES = 200_000

/** How often a running task's log is size-checked against the cap. */
export const BG_LOG_CHECK_INTERVAL_MS = 2_000

function truncationNotice(capBytes: number): string {
  return `[... earlier output truncated: background task log rolled at ${capBytes} bytes ...]\n`
}

/**
 * Prefixes the command with an `exec` redirect to $BUTTERFLY_BG_LOG. Unlike a
 * `{ ...; } >> file` group this works with any command shape, since the
 * user's text is only preceded, never wrapped. Returns undefined for shells
 * that cannot log reliably when detached; callers must refuse.
 */
export function wrapBackgroundCommand(family: ShellFamily, command: string): string | undefined {
  if (family !== "posix") return undefined
  return `exec >>"$${BG_LOG_ENV}" 2>&1\n${command}`
}

/** Minimal journal seam; any append-shaped sink (SessionJournal) fits. */
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
  /** Optional bgtask.start/end audit trail. */
  journal?: BgTaskJournalSink
  /** Defaults to BG_LOG_CAP_BYTES. */
  logCapBytes?: number
  /** Defaults to BG_LOG_CHECK_INTERVAL_MS. */
  logCheckIntervalMs?: number
  /** Test seam; defaults to resolveShell(). */
  shell?: () => ShellResolution
  /** Fires once per task when it exits or is killed. */
  onEnd?: (record: BgTaskRecord) => void
}

interface RunningEntry {
  record: BgTaskRecord
  proc: ReturnType<typeof Bun.spawn>
}

/**
 * Process-exit reaper for every registry with running tasks. Only an "exit"
 * listener: a SIGINT/SIGTERM listener would suppress the default
 * die-on-signal. killTree is synchronous, so reaping from "exit" is safe.
 */
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

  /**
   * Spawns detached via the same shell resolution as foreground bash and
   * returns without awaiting the process. Throws, spawning nothing, when the
   * resolved shell cannot host a background task.
   */
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
      // No pipes: a pipe's read end dies with the parent. The shell owns the log fd.
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
    // Without unref() the parent waits out the child's lifetime before exiting.
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

  /** Unref'd so cap enforcement never keeps the process alive. */
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

  /**
   * Rolls the log to a notice plus the most recent half-cap. The child writes
   * with O_APPEND, so it continues at the new end of file. Output written
   * between the read and the rewrite is lost.
   */
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
    // kill() may already have finished this record.
    if (!this.running.has(id)) return
    this.finish(id, "exited", exitCode)
  }

  private finish(id: string, status: "exited" | "killed", exitCode?: number): void {
    const entry = this.running.get(id)
    if (!entry) return
    this.running.delete(id)
    // Final cap pass for output written right before exit.
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

  /** False for an unknown or already-finished id; never throws. */
  kill(id: string): boolean {
    const entry = this.running.get(id)
    if (!entry) return false
    killTree(entry.proc)
    this.finish(id, "killed")
    return true
  }

  /** Last `maxChars` characters of the log, read from the end of the file.
   * Undefined for an unknown id; "" if the file is unreadable. */
  tail(id: string, maxChars = 2_000): string | undefined {
    const record = this.get(id)
    if (!record) return undefined
    try {
      // 4 bytes/char is the UTF-8 worst case, so this never under-reads.
      const text = readTailBytes(record.logPath, maxChars * 4).toString("utf8")
      return text.length > maxChars ? text.slice(-maxChars) : text
    } catch {
      return ""
    }
  }

  /**
   * Kills every running task not spawned with keepAlive. Synchronous, so it
   * is safe on a quit path including process "exit". Returns the ids killed.
   */
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

/** Reads at most `maxBytes` from the end of a file. */
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
