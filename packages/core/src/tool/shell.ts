import { join } from "node:path"

/** Dialect of the resolved shell, for callers that generate shell syntax. */
export type ShellFamily = "posix" | "powershell" | "cmd"

export interface ShellResolution {
  exe: string
  args: (cmd: string) => string[]
  family: ShellFamily
}

/**
 * On Windows: Git Bash located via which("git") (Bun.which("bash") finds the
 * WSL launcher), then pwsh/powershell, then COMSPEC. Git Bash comes first
 * because models emit POSIX commands. Override: BUTTERFLY_GIT_BASH_PATH.
 */
export function resolveShell(): ShellResolution {
  // Non-login (-c, not -lc): stateless spawns must not pay profile-sourcing
  // latency on every tool call; env comes from the parent process.
  if (process.platform !== "win32") {
    return { exe: Bun.which("bash") ?? "/bin/sh", args: (c) => ["-c", c], family: "posix" }
  }
  const override = process.env["BUTTERFLY_GIT_BASH_PATH"]
  const git = Bun.which("git")
  // git.exe may live in Git\cmd (2 levels up to the root) or Git\mingw64\bin /
  // Git\usr\bin (3 levels up) depending on the parent shell's PATH.
  const candidates = override
    ? [override]
    : git
      ? [join(git, "..", "..", "bin", "bash.exe"), join(git, "..", "..", "..", "bin", "bash.exe")]
      : []
  for (const gitBash of candidates) {
    if (Bun.file(gitBash).size > 0) {
      return { exe: gitBash, args: (c) => ["-c", c], family: "posix" }
    }
  }
  const ps = Bun.which("pwsh") ?? Bun.which("powershell")
  if (ps) {
    return {
      exe: ps,
      args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
      family: "powershell",
    }
  }
  return {
    exe: process.env["COMSPEC"] ?? "cmd.exe",
    args: (c) => ["/d", "/s", "/c", c],
    family: "cmd",
  }
}

/** Kills the whole process tree. proc.kill() orphans grandchildren on
 * Windows, so taskkill /T is used there. */
export function killTree(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    })
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      proc.kill()
    }
  }
}

export interface RunCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  /** Stopped by its signal or killCommand() — not by the timeout. */
  killed?: boolean
}

/**
 * Capture cap per stream, so `yes` or a log flood cannot exhaust memory.
 * Head and tail are kept (errors live at both ends); the middle is elided.
 */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

export async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_CAPTURE_BYTES,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<string> {
  const headLimit = Math.floor(maxBytes * 0.6)
  const tailLimit = maxBytes - headLimit
  const head: Uint8Array[] = []
  let headBytes = 0
  let tail: Uint8Array[] = []
  let tailBytes = 0
  let dropped = 0
  for await (const chunk of stream) {
    onChunk?.(chunk)
    let rest = chunk
    if (headBytes < headLimit) {
      const take = rest.subarray(0, headLimit - headBytes)
      head.push(take)
      headBytes += take.length
      rest = rest.subarray(take.length)
    }
    if (rest.length === 0) continue
    tail.push(rest)
    tailBytes += rest.length
    while (tailBytes > tailLimit && tail.length > 0) {
      const first = tail[0] as Uint8Array
      const excess = tailBytes - tailLimit
      if (first.length <= excess) {
        tail.shift()
        tailBytes -= first.length
        dropped += first.length
      } else {
        tail = [first.subarray(excess), ...tail.slice(1)]
        tailBytes -= excess
        dropped += excess
      }
    }
  }
  const decoder = new TextDecoder()
  // Nothing dropped: decode as one buffer so a multi-byte character that
  // straddles the head/tail split stays intact.
  if (dropped === 0) return decoder.decode(Buffer.concat([...head, ...tail]))
  const headText = decoder.decode(Buffer.concat(head))
  const tailText = decoder.decode(Buffer.concat(tail))
  return `${headText}\n[... ${dropped} bytes of output not captured ...]\n${tailText}`
}

/**
 * Foreground commands currently running, by id (the tool call id). Lets a
 * UI stop ONE command without interrupting the whole turn — the command
 * ends as killed and the model sees that in its result.
 */
const liveCommands = new Map<string, () => void>()

/** Kill a running foreground command started with `runCommand({ id })`. */
export function killCommand(id: string): boolean {
  const kill = liveCommands.get(id)
  if (!kill) return false
  kill()
  return true
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const MAX_COMMAND_TIMEOUT_MS = 600_000

/** Stateless command execution (no persistent shell). Pagers and progress
 * bars are disabled because they pollute the output. */
export async function runCommand(
  command: string,
  opts: {
    cwd: string
    timeoutMs?: number
    env?: Record<string, string>
    /** Kills the command (and its children) when fired. */
    signal?: AbortSignal
    /** Live output, stdout and stderr interleaved, as it arrives (UI only). */
    onOutput?: (text: string) => void
    /** Registers the command for killCommand(id) while it runs. */
    id?: string
  },
): Promise<RunCommandResult> {
  const { exe, args } = resolveShell()
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS)

  const proc = Bun.spawn([exe, ...args(command)], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    // POSIX: own process group, so killTree's kill(-pid) takes the whole tree;
    // killing only the shell leaves children holding the pipes open.
    ...(process.platform !== "win32" ? { detached: true } : {}),
    env: {
      ...process.env,
      PAGER: "cat",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      TQDM_DISABLE: "1",
      NO_COLOR: "1",
      ...opts.env,
    },
  })

  let timedOut = false
  let killed = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(proc)
  }, timeoutMs)
  const kill = () => {
    if (killed) return
    killed = true
    killTree(proc)
  }
  if (opts.signal?.aborted) kill()
  opts.signal?.addEventListener("abort", kill, { once: true })
  if (opts.id !== undefined) liveCommands.set(opts.id, kill)

  const onOutput = opts.onOutput
  const decoders = [new TextDecoder(), new TextDecoder()]
  const tee = onOutput
    ? (n: 0 | 1) => (chunk: Uint8Array) => {
        try {
          onOutput((decoders[n] as TextDecoder).decode(chunk, { stream: true }))
        } catch {
          // a UI callback must never break the command
        }
      }
    : undefined

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      collectBounded(proc.stdout, MAX_CAPTURE_BYTES, tee?.(0)),
      collectBounded(proc.stderr, MAX_CAPTURE_BYTES, tee?.(1)),
      proc.exited,
    ])
    return { stdout, stderr, exitCode, timedOut, ...(killed ? { killed: true } : {}) }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", kill)
    if (opts.id !== undefined && liveCommands.get(opts.id) === kill) liveCommands.delete(opts.id)
  }
}
