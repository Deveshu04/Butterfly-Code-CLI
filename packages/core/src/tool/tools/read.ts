import { readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { z } from "zod"
import type { ToolDefinition } from "../registry"

export const readInput = z.object({
  file_path: z.string().describe("Absolute or cwd-relative path to the file"),
  offset: z.number().int().min(1).optional().describe("1-based line to start from"),
  limit: z.number().int().min(1).optional().describe("Maximum lines to return"),
})

export const DEFAULT_READ_LIMIT = 500

/** ctx.state key: identical-read cache (path + window → content hash + callId). */
export const READ_CACHE_KEY = "readCache"

interface ReadRecord {
  hash: string
  callId: string
}

export const readTool: ToolDefinition<z.infer<typeof readInput>> = {
  name: "read",
  description:
    "Read a file with line numbers. Returns up to 500 lines by default; use offset/limit for large files. The banner reports the total line count.",
  inputSchema: readInput,
  permissionTarget: (input) => input.file_path,
  async execute(input, ctx) {
    const path = isAbsolute(input.file_path) ? input.file_path : join(ctx.cwd, input.file_path)
    let content: string
    try {
      content = readFileSync(path, "utf8")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        output: `Cannot read ${input.file_path}: ${message}. Check the path (cwd: ${ctx.cwd}) — use glob to locate files.`,
        isError: true,
      }
    }

    if (!(ctx.state[READ_CACHE_KEY] instanceof Map)) ctx.state[READ_CACHE_KEY] = new Map()
    const cache = ctx.state[READ_CACHE_KEY] as Map<string, ReadRecord>
    const key = `${path}\0${input.offset ?? 1}\0${input.limit ?? DEFAULT_READ_LIMIT}`
    const hash = Bun.hash(content).toString(36)
    const previous = cache.get(key)
    if (previous && previous.hash === hash && ctx.isResultVisible?.(previous.callId) === true) {
      return {
        output: `[unchanged] ${input.file_path}: this exact range is identical to your earlier read in this conversation — use that result instead of reading it again.`,
      }
    }
    if (ctx.callId !== undefined) cache.set(key, { hash, callId: ctx.callId })

    const lines = content.split("\n")
    if (lines.at(-1) === "") lines.pop()
    const total = lines.length
    const offset = input.offset ?? 1
    const limit = input.limit ?? DEFAULT_READ_LIMIT
    const window = lines.slice(offset - 1, offset - 1 + limit)

    if (window.length === 0) {
      return {
        output: `${input.file_path} has ${total} lines; offset ${offset} is past the end.`,
        isError: true,
      }
    }

    const banner =
      window.length === total
        ? `[${input.file_path}: ${total} lines]`
        : `[${input.file_path}: showing lines ${offset}-${offset + window.length - 1} of ${total}]`
    const numbered = window.map((line, i) => `${offset + i}\t${line}`).join("\n")
    return { output: `${banner}\n${numbered}` }
  },
}
