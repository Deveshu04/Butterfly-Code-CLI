import { z } from "zod"
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
})

export const bashTool: ToolDefinition<z.infer<typeof bashInput>> = {
  name: "bash",
  description:
    "Execute one shell command in the workspace (stateless — no shell state persists between calls). POSIX syntax. Default timeout 2 minutes, max 10. Non-zero exit codes are reported as errors with the output.",
  inputSchema: bashInput,
  permissionTarget: (input) => input.command,
  async execute(input, ctx) {
    const result = await runCommand(input.command, { cwd: ctx.cwd, timeoutMs: input.timeout })

    const parts: string[] = []
    if (result.stdout.trim() !== "") parts.push(result.stdout.trimEnd())
    if (result.stderr.trim() !== "") parts.push(`[stderr]\n${result.stderr.trimEnd()}`)

    if (result.timedOut) {
      const limit = input.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS
      parts.push(`Command timed out after ${limit}ms and was killed (including child processes).`)
      return { output: parts.join("\n"), isError: true }
    }
    if (result.exitCode !== 0) {
      parts.push(`(exit code ${result.exitCode})`)
      return { output: parts.join("\n"), isError: true }
    }
    if (parts.length === 0) {
      return { output: "(command completed with no output)" }
    }
    return { output: parts.join("\n") }
  },
}
