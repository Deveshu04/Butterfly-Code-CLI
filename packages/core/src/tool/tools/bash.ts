import { join } from "node:path"
import { z } from "zod"
import { BG_TASKS_STATE_KEY, BgTaskRegistry } from "../bg-tasks"
import { cleanCommandOutput } from "../output-hygiene"
import type { ToolDefinition } from "../registry"
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, runCommand } from "../shell"

export const bashInput = z.object({
  command: z.string().describe("Shell command to execute (POSIX syntax; Git Bash on Windows)"),
  timeout: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_COMMAND_TIMEOUT_MS)
    .optional()
    .describe("Timeout in milliseconds (default 120000)"),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run in the background: returns immediately with a task id instead of waiting for the command to finish. Output streams to a log file (path returned) — read it with the read tool to check progress, or use /tasks. Use for long-running commands (servers, watchers, long builds).",
    ),
  keepAlive: z
    .boolean()
    .optional()
    .describe(
      "Only meaningful with background:true. Without it, the task is killed when the session ends. Set true to let it survive session exit.",
    ),
})

function bgRegistry(ctx: { cwd: string; state: Record<string, unknown> }): BgTaskRegistry {
  const existing = ctx.state[BG_TASKS_STATE_KEY]
  if (existing instanceof BgTaskRegistry) return existing
  const registry = new BgTaskRegistry({ cwd: ctx.cwd, logDir: join(ctx.cwd, ".butterfly", "bg") })
  ctx.state[BG_TASKS_STATE_KEY] = registry
  return registry
}

export const bashTool: ToolDefinition<z.infer<typeof bashInput>> = {
  name: "bash",
  description:
    "Execute one shell command in the workspace (stateless — no shell state persists between calls). POSIX syntax. Default timeout 2 minutes, max 10. Non-zero exit codes are reported as errors with the output. background:true runs it detached instead of waiting.",
  inputSchema: bashInput,
  permissionTarget: (input) => input.command,
  async execute(input, ctx) {
    if (input.background === true) {
      const registry = bgRegistry(ctx)
      let record: ReturnType<BgTaskRegistry["spawn"]>
      try {
        record = registry.spawn(input.command, { keepAlive: input.keepAlive === true })
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        }
      }
      return {
        output: `Started background task ${record.id} (pid ${record.pid}). Output streaming to ${record.logPath} — read it with the read tool to check progress. Use /tasks show ${record.id} or /tasks kill ${record.id}.`,
      }
    }

    const result = await runCommand(input.command, { cwd: ctx.cwd, timeoutMs: input.timeout })
    const meta = { command: input.command, exitCode: result.exitCode }

    const stdout = cleanCommandOutput(result.stdout)
    const stderr = cleanCommandOutput(result.stderr)
    const parts: string[] = []
    if (stdout.trim() !== "") parts.push(stdout.trimEnd())
    if (stderr.trim() !== "") parts.push(`[stderr]\n${stderr.trimEnd()}`)

    if (result.timedOut) {
      const limit = input.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS
      parts.push(`Command timed out after ${limit}ms and was killed (including child processes).`)
      return { output: parts.join("\n"), isError: true, meta }
    }
    if (result.exitCode !== 0) {
      parts.push(`(exit code ${result.exitCode})`)
      return { output: parts.join("\n"), isError: true, meta }
    }
    if (parts.length === 0) {
      return { output: "(command completed with no output)", meta }
    }
    return { output: parts.join("\n"), meta }
  },
}
