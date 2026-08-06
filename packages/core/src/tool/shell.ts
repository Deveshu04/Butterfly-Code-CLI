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
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)

  return { stdout, stderr, exitCode, timedOut }
}
