import { z } from "zod"
import type { ToolDefinition } from "../tool/registry"
import type { McpHub } from "./hub"

export const mcpToolInput = z.object({
  op: z.enum(["list", "describe", "call"]),
  server: z.string().optional().describe("Server name (describe/call)"),
  tool: z.string().optional().describe("Tool name (describe/call)"),
  args: z.record(z.string(), z.unknown()).optional().describe("Arguments for call"),
})

/**
 * One tool fronts every connected MCP server (lazy disclosure):
 * list → one-line index · describe → full schema on demand · call → invoke.
 */
export function createMcpTool(opts: {
  hub: () => McpHub | undefined
}): ToolDefinition<z.infer<typeof mcpToolInput>> {
  return {
    name: "mcp",
    description:
      "Access connected MCP servers. op=list: one-line index of every external tool. op=describe (server, tool): full input schema — ALWAYS describe before first use. op=call (server, tool, args): invoke.",
    inputSchema: mcpToolInput,
    async execute(input) {
      const hub = opts.hub()
      if (!hub) {
        return {
          output: "No MCP servers connected (configure them under mcp in butterfly.jsonc).",
          isError: true,
        }
      }
      switch (input.op) {
        case "list": {
          const index = hub.index()
          if (index === "") return { output: "No MCP tools available." }
          return {
            output: `${index}\n\nUse op=describe before calling a tool for the first time.`,
          }
        }
        case "describe": {
          if (!input.server || !input.tool) {
            return { output: "describe requires server and tool.", isError: true }
          }
          const description = hub.describe(input.server, input.tool)
          if (!description) {
            return {
              output: `No tool "${input.server}/${input.tool}" — op=list shows what exists.`,
              isError: true,
            }
          }
          return { output: description }
        }
        case "call": {
          if (!input.server || !input.tool) {
            return { output: "call requires server and tool.", isError: true }
          }
          return await hub.call(input.server, input.tool, input.args ?? {})
        }
      }
    },
  }
}
