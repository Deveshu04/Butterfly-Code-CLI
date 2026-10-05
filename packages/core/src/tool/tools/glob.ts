import { resolve } from "node:path"
import { z } from "zod"
import type { ToolDefinition } from "../registry"

export const globInput = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts"'),
  cwd: z.string().optional().describe("Directory to search from (defaults to workspace cwd)"),
})

export const GLOB_RESULT_CAP = 200

/** Paths never surfaced to the model: large, low-value token sinks. */
export const DEFAULT_IGNORED_SEGMENTS = ["node_modules", ".git", "dist", ".butterfly"]

export const globTool: ToolDefinition<z.infer<typeof globInput>> = {
  name: "glob",
  description:
    "Find files by glob pattern. Results are sorted and capped at 200; node_modules, .git, dist and .butterfly are always excluded.",
  inputSchema: globInput,
  async execute(input, ctx) {
    const cwd = input.cwd ? resolve(ctx.cwd, input.cwd) : ctx.cwd
    const glob = new Bun.Glob(input.pattern)
    const entries: string[] = []
    for (const entry of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
      const normalized = entry.replaceAll("\\", "/")
      const segments = normalized.split("/")
      if (DEFAULT_IGNORED_SEGMENTS.some((ignored) => segments.includes(ignored))) continue
      entries.push(normalized)
    }
    entries.sort()

    if (entries.length === 0) {
      return { output: `No files match "${input.pattern}" under ${cwd}.` }
    }

    const shown = entries.slice(0, GLOB_RESULT_CAP)
    const hidden = entries.length - shown.length
    const suffix = hidden > 0 ? `\n[... ${hidden} more matches not shown — narrow the pattern]` : ""
    return { output: `${shown.join("\n")}${suffix}` }
  },
}
