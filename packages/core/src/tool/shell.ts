import { join } from "node:path"

export type ShellFamily = "posix" | "powershell" | "cmd"

export interface ShellResolution {
  exe: string
  args: (cmd: string) => string[]
  family: ShellFamily
}

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
}

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

export async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = MAX_CAPTURE_BYTES,
): Promise<string> {
  const headLimit = Math.floor(maxBytes * 0.6)
  const tailLimit = maxBytes - headLimit
  const head: Uint8Array[] = []
  let headBytes = 0
  let tail: Uint8Array[] = []
  let tailBytes = 0
  let dropped = 0
  for await (const chunk of stream) {
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

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const MAX_COMMAND_TIMEOUT_MS = 600_000

export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<RunCommandResult> {
  const { exe, args } = resolveShell()
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS)

  const proc = Bun.spawn([exe, ...args(command)], {
    cwd: opts.cwd,
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
      ...opts.env,
    },
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(proc)
  }, timeoutMs)

  const [stdout, stderr, exitCode] = await Promise.all([
    collectBounded(proc.stdout),
    collectBounded(proc.stderr),
    proc.exited,
  ])
  clearTimeout(timer)

  return { stdout, stderr, exitCode, timedOut }
}
