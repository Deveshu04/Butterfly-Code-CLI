import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { estimateTokens } from "../context/tokens"


export interface McpServerConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: unknown
}

interface ServerEntry {
  name: string
  client?: Client
  tools: McpToolInfo[]
  error?: string
}

export interface McpConnectOptions {
  /** Test seam: supply the transport instead of stdio/http construction. */
  transportFactory?: (name: string, config: McpServerConfig) => Transport | Promise<Transport>
  timeoutMs?: number
}

const CONNECT_TIMEOUT_MS = 15_000
const INDEX_LINE_DESC_CAP = 80

function defaultTransport(config: McpServerConfig): Transport {
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...config.env },
    })
  }
  if (config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    })
  }
  throw new Error("server config needs either command (stdio) or url (http)")
}

export class McpHub {
  private constructor(private entries: Map<string, ServerEntry>) {}

  static async connect(
    configs: Record<string, McpServerConfig>,
    opts: McpConnectOptions = {},
  ): Promise<McpHub> {
    const entries = new Map<string, ServerEntry>()
    await Promise.all(
      Object.entries(configs).map(async ([name, config]) => {
        try {
          const transport = opts.transportFactory
            ? await opts.transportFactory(name, config)
            : defaultTransport(config)
          const client = new Client({ name: "butterfly-code", version: "0.0.1" })
          const timeout = opts.timeoutMs ?? CONNECT_TIMEOUT_MS
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`connect timed out after ${timeout}ms`)), timeout),
            ),
          ])
          const list = await client.listTools()
          entries.set(name, {
            name,
            client,
            tools: list.tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema,
            })),
          })
        } catch (error) {
          entries.set(name, {
            name,
            tools: [],
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }),
    )
    return new McpHub(entries)
  }

  status(): { name: string; toolCount: number; error?: string }[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      toolCount: entry.tools.length,
      ...(entry.error ? { error: entry.error } : {}),
    }))
  }

  /** L0 index: one line per tool. This is ALL the model pays for up front. */
  index(): string {
    const lines: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.error) {
        lines.push(`${entry.name}: (unavailable — ${entry.error.slice(0, 60)})`)
        continue
      }
      for (const tool of entry.tools) {
        const firstLine = tool.description.split("\n")[0]?.slice(0, INDEX_LINE_DESC_CAP) ?? ""
        lines.push(`${entry.name}/${tool.name} — ${firstLine}`)
      }
    }
    return lines.join("\n")
  }

  eagerTokens(): number {
    let total = 0
    for (const entry of this.entries.values()) {
      for (const tool of entry.tools) {
        total += estimateTokens(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            schema: tool.inputSchema,
          }),
        )
      }
    }
    return total
  }

  indexTokens(): number {
    return estimateTokens(this.index())
  }

  /** Per-server breakdown of the same eager-vs-index measurement, for /doctor. */
  serverTokenSavings(): { name: string; eagerTokens: number; indexTokens: number }[] {
    const rows: { name: string; eagerTokens: number; indexTokens: number }[] = []
    for (const entry of this.entries.values()) {
      const lines: string[] = []
      let eager = 0
      if (entry.error) {
        lines.push(`${entry.name}: (unavailable — ${entry.error.slice(0, 60)})`)
      } else {
        for (const tool of entry.tools) {
          eager += estimateTokens(
            JSON.stringify({
              name: tool.name,
              description: tool.description,
              schema: tool.inputSchema,
            }),
          )
          const firstLine = tool.description.split("\n")[0]?.slice(0, INDEX_LINE_DESC_CAP) ?? ""
          lines.push(`${entry.name}/${tool.name} — ${firstLine}`)
        }
      }
      rows.push({
        name: entry.name,
        eagerTokens: eager,
        indexTokens: estimateTokens(lines.join("\n")),
      })
    }
    return rows
  }

  describe(server: string, tool: string): string | null {
    const info = this.entries.get(server)?.tools.find((t) => t.name === tool)
    if (!info) return null
    return `${server}/${info.name}\n${info.description}\n\ninput schema:\n${JSON.stringify(info.inputSchema, null, 2)}`
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ output: string; isError: boolean }> {
    const entry = this.entries.get(server)
    if (!entry?.client) {
      return { output: `MCP server "${server}" is not connected.`, isError: true }
    }
    try {
      const result = await entry.client.callTool({ name: tool, arguments: args })
      const content = Array.isArray(result.content) ? result.content : []
      const text = content
        .map((part) =>
          part.type === "text"
            ? part.text
            : `[${part.type} content — not renderable in the terminal]`,
        )
        .join("\n")
      return { output: text || "(no content returned)", isError: result.isError === true }
    } catch (error) {
      return {
        output: `MCP call failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  }

  async close(): Promise<void> {
    for (const entry of this.entries.values()) {
      try {
        await entry.client?.close()
      } catch {
        // already gone
      }
    }
  }
}
