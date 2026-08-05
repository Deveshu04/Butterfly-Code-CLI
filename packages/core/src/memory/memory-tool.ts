import { z } from "zod"
import type { ToolDefinition } from "../tool/registry"
import type { EpisodicIndex } from "./episodic"
import { applyMemoryOp, type MemoryPaths } from "./files"

export const memoryToolInput = z.object({
  op: z.enum(["add", "replace", "remove", "search"]),
  scope: z.enum(["project", "user"]).optional().describe("Required for add/replace/remove"),
  text: z.string().optional().describe("add: the fact to store (one terse line)"),
  find: z.string().optional().describe("replace/remove: exact substring to target"),
  replace: z.string().optional().describe("replace: the new text"),
  query: z.string().optional().describe("search: what to look for in past sessions"),
})

export function createMemoryTool(opts: {
  paths: MemoryPaths
  episodic: () => EpisodicIndex | undefined
  approval?: boolean
}): ToolDefinition<z.infer<typeof memoryToolInput>> {
  return {
    name: "memory",
    description:
      "Persistent memory. op=add/replace/remove: store or amend durable project/user facts (capped; takes effect next session). op=search: full-text search verbatim transcripts of past sessions.",
    inputSchema: memoryToolInput,
    async execute(input) {
      if (input.op === "search") {
        if (!input.query || input.query.trim() === "") {
          return { output: "search requires a query.", isError: true }
        }
        const index = opts.episodic()
        if (!index) {
          return { output: "Episodic index not available in this session.", isError: true }
        }
        const hits = index.search(input.query, 8)
        if (hits.length === 0) return { output: `No past-session matches for "${input.query}".` }
        const rendered = hits
          .map(
            (hit) =>
              `[${hit.time.slice(0, 10)} ${hit.type} session ${hit.sessionId.slice(0, 8)}]\n${hit.text.slice(0, 400)}`,
          )
          .join("\n\n")
        return { output: rendered }
      }

      if (!input.scope) {
        return {
          output: `${input.op} requires a scope: "project" (shared, in .butterfly/PROJECT.md) or "user" (personal preferences).`,
          isError: true,
        }
      }
      const result = applyMemoryOp(
        opts.paths,
        {
          op: input.op,
          scope: input.scope,
          text: input.text,
          find: input.find,
          replace: input.replace,
        },
        { approval: opts.approval },
      )
      if (!result.ok) return { output: result.message, isError: true }
      const suffix = result.staged
        ? "Staged for human approval."
        : "Saved — becomes part of the prompt at the next session (memory is frozen for this one)."
      return { output: `${suffix}\nCurrent ${input.scope} memory:\n${result.content.trimEnd()}` }
    },
  }
}
