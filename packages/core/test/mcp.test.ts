import { expect, test } from "bun:test"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { McpHub } from "../src/mcp/hub"
import { createMcpTool } from "../src/mcp/mcp-tool"
import type { ToolContext } from "../src/tool/registry"

function ctx(): ToolContext {
  return { cwd: "/w", rules: { "*": "allow" }, state: {} }
}

async function hubWithTestServer(): Promise<McpHub> {
  const server = new McpServer({ name: "test-server", version: "1.0.0" })
  server.registerTool(
    "lookup_docs",
    {
      description:
        "Look up documentation for a library.\nSupports fuzzy matching and version pins.",
      inputSchema: { library: z.string(), version: z.string().optional() },
    },
    async ({ library }) => ({
      content: [{ type: "text", text: `docs for ${library}: install with bun add ${library}` }],
    }),
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return McpHub.connect({ docs: {} }, { transportFactory: () => clientTransport })
}

test("hub connects, indexes one line per tool, and measures the savings", async () => {
  const hub = await hubWithTestServer()
  expect(hub.status()).toEqual([{ name: "docs", toolCount: 1 }])

  const index = hub.index()
  expect(index).toContain("docs/lookup_docs — Look up documentation for a library.")
  expect(index).not.toContain("fuzzy matching") // only the first line, capped

  // The headline number: lazy index must be far cheaper than eager schemas.
  expect(hub.indexTokens()).toBeLessThan(hub.eagerTokens())
  await hub.close()
})

test("serverTokenSavings breaks the eager/index measurement down per server", async () => {
  const hub = await hubWithTestServer()
  const rows = hub.serverTokenSavings()
  expect(rows).toEqual([
    { name: "docs", eagerTokens: hub.eagerTokens(), indexTokens: hub.indexTokens() },
  ])
  await hub.close()
})

test("describe returns the full schema on demand; call invokes", async () => {
  const hub = await hubWithTestServer()
  const description = hub.describe("docs", "lookup_docs")
  expect(description).toContain("library")
  expect(description).toContain("input schema")

  const result = await hub.call("docs", "lookup_docs", { library: "zod" })
  expect(result.isError).toBe(false)
  expect(result.output).toContain("docs for zod")
  await hub.close()
})

test("a failing server records its error without breaking the hub", async () => {
  const hub = await McpHub.connect(
    {
      broken: {},
      // no command/url and no factory override for this one
    },
    {
      transportFactory: () => {
        throw new Error("boom transport")
      },
    },
  )
  const status = hub.status()
  expect(status[0]?.error).toContain("boom")
  expect(hub.index()).toContain("unavailable")
  const result = await hub.call("broken", "x", {})
  expect(result.isError).toBe(true)
})

test("the mcp tool routes list/describe/call and validates prerequisites", async () => {
  const hub = await hubWithTestServer()
  const tool = createMcpTool({ hub: () => hub })

  const list = await tool.execute({ op: "list" }, ctx())
  expect(list.output).toContain("docs/lookup_docs")

  const describe = await tool.execute(
    { op: "describe", server: "docs", tool: "lookup_docs" },
    ctx(),
  )
  expect(describe.output).toContain("input schema")

  const missing = await tool.execute({ op: "call" }, ctx())
  expect(missing.isError).toBe(true)

  const call = await tool.execute(
    { op: "call", server: "docs", tool: "lookup_docs", args: { library: "hono" } },
    ctx(),
  )
  expect(call.output).toContain("docs for hono")

  const noHub = createMcpTool({ hub: () => undefined })
  const unavailable = await noHub.execute({ op: "list" }, ctx())
  expect(unavailable.isError).toBe(true)
  await hub.close()
})
