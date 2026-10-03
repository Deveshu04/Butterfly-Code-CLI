import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  McpHub,
  type McpServerConfig,
  type ProviderPort,
  type TurnEvent,
  type TurnRequest,
  type Usage,
} from "@butterfly/core"
import { connectAcpAgent } from "../src/acp/agent"



class MockProvider implements ProviderPort {
  readonly requests: TurnRequest[] = []
  private scripts: TurnEvent[][]
  constructor(scripts: TurnEvent[][]) {
    this.scripts = [...scripts]
  }
  async *streamTurn(request: TurnRequest): AsyncIterable<TurnEvent> {
    this.requests.push(request)
    const script = this.scripts.shift()
    if (!script) throw new Error("MockProvider: no script left for this call")
    yield* script
  }
}

const zeroUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function gitCwd(prefix: string): string {
  const cwd = tempDir(prefix)
  Bun.spawnSync(["git", "init", "-q"], { cwd, stdout: "ignore", stderr: "ignore" })
  return cwd
}

function makeAgent(
  provider: ProviderPort,
  opts: {
    model?: string
    home: string
    permissionTimeoutMs?: number
    mcpConnect?: (configs: Record<string, McpServerConfig>) => Promise<McpHub>
  },
) {
  const sent: string[] = []
  const logs: string[] = []
  const { peer, agent } = connectAcpAgent(
    (line) => {
      sent.push(line)
    },
    {
      provider,
      ...(opts.model ? { model: opts.model } : {}),
      home: opts.home,
      ...(opts.permissionTimeoutMs !== undefined
        ? { permissionTimeoutMs: opts.permissionTimeoutMs }
        : {}),
      ...(opts.mcpConnect ? { mcpConnect: opts.mcpConnect } : {}),
      onLog: (message: string) => {
        logs.push(message)
      },
    },
  )
  return { peer, agent, sent, logs }
}

/** Provider script pair for "one tool call, then a plain text finish". */
function oneToolCallThenText(
  call: { callId: string; name: string; input: unknown },
  text = "done",
): TurnEvent[][] {
  return [
    [
      { type: "tool-call", ...call },
      { type: "finish", reason: "tool-calls", usage: zeroUsage },
    ],
    [
      { type: "text-delta", text },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ]
}

// biome-ignore lint/suspicious/noExplicitAny: test-only JSON-RPC frame inspection
function parsed(sent: string[]): any[] {
  return sent.map((line) => JSON.parse(line))
}

const bgPids: number[] = []
afterEach(() => {
  for (const pid of bgPids.splice(0)) {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      })
    } else {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // already gone
        }
      }
    }
  }
})

function isAlive(pid: number): boolean {
  if (process.platform === "win32") {
    return Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"])
      .stdout.toString()
      .includes(String(pid))
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value !== undefined) return value
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}


test("initialize: negotiates protocol version 1 and advertises honest capabilities", async () => {
  const home = tempDir("bfly-acp-home-")
  const { peer, sent } = makeAgent(new MockProvider([]), { home })

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: "test-client", version: "0.1.0" },
      },
    }),
  )

  expect(sent).toHaveLength(1)
  const response = parsed(sent)[0]
  expect(response.id).toBe(0)
  expect(response.result.protocolVersion).toBe(1)
  expect(response.result.agentCapabilities.loadSession).toBe(false)
  expect(response.result.agentCapabilities.promptCapabilities).toEqual({
    image: true,
    audio: false,
    embeddedContext: true,
  })
  // McpHub does stdio (mandatory) + streamable HTTP, and no legacy SSE.
  expect(response.result.agentCapabilities.mcpCapabilities).toEqual({ http: true, sse: false })
  expect(response.result.agentInfo.name).toBe("butterfly")
  expect(response.result.authMethods).toEqual([])
})


test("a malformed JSON line gets a JSON-RPC parse error, not a crash", async () => {
  const home = tempDir("bfly-acp-home-")
  const { peer, sent } = makeAgent(new MockProvider([]), { home })

  await peer.handleLine("{not valid json")

  expect(sent).toHaveLength(1)
  const response = parsed(sent)[0]
  expect(response.id).toBeNull()
  expect(response.error.code).toBe(-32700)
})

test("an unimplemented method returns method-not-found, not a silent no-op", async () => {
  const home = tempDir("bfly-acp-home-")
  const { peer, sent } = makeAgent(new MockProvider([]), { home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/load", params: {} }),
  )

  const response = parsed(sent)[0]
  expect(response.error.code).toBe(-32601)
})

test("session/new with a missing cwd returns invalid-params", async () => {
  const home = tempDir("bfly-acp-home-")
  const { peer, sent } = makeAgent(new MockProvider([]), { home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }),
  )

  const response = parsed(sent)[0]
  expect(response.error.code).toBe(-32602)
})

test("session/prompt with an unknown sessionId returns invalid-params", async () => {
  const home = tempDir("bfly-acp-home-")
  const { peer, sent } = makeAgent(new MockProvider([]), { home, model: "mock/model" })

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "sess_nope", prompt: [{ type: "text", text: "hi" }] },
    }),
  )

  const response = parsed(sent)[0]
  expect(response.error.code).toBe(-32602)
})

test("session/new without a configured model asks for auth instead of hanging or crashing", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = tempDir("bfly-acp-cwd-")
  const { peer, sent } = makeAgent(new MockProvider([]), { home }) // no model configured anywhere

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )

  const response = parsed(sent)[0]
  expect(response.error.code).toBe(-32000)
  expect(response.error.data.authMethods[0].id).toBe("config")
})


test("session/prompt streams agent_message_chunk updates and resolves end_turn", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ])
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "say hello" }] },
    }),
  )

  const messages = parsed(sent)
  const chunks = messages
    .filter(
      (m) =>
        m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk",
    )
    .map((m) => m.params.update.content.text)
  expect(chunks.join("")).toBe("hello")
  for (const m of messages.filter((m) => m.method === "session/update")) {
    expect(m.params.sessionId).toBe(sessionId)
  }

  const finalResponse = messages.find((m) => m.id === 2)
  expect(finalResponse.result.stopReason).toBe("end_turn")
}, 20_000)


test("an edit under an ask rule round-trips session/request_permission and reports a diff", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "c1",
        name: "edit",
        input: { file_path: "a.txt", old_string: "", new_string: "hi" },
      },
      { type: "finish", reason: "tool-calls", usage: zeroUsage },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ])
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  const promptPromise = peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create a.txt" }] },
    }),
  )

  const permissionRequest = await waitFor(() =>
    parsed(sent).find((m) => m.method === "session/request_permission"),
  )
  expect(permissionRequest.params.toolCall.toolCallId).toBe("c1")
  expect(permissionRequest.params.options.map((o: { optionId: string }) => o.optionId)).toEqual([
    "allow-once",
    "allow-always",
    "reject-once",
    "reject-always",
  ])

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: permissionRequest.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    }),
  )
  await promptPromise

  const messages = parsed(sent)
  const toolCall = messages.find((m) => m.params?.update?.sessionUpdate === "tool_call")
  expect(toolCall.params.update.kind).toBe("edit")
  expect(toolCall.params.update.status).toBe("pending")

  const completed = messages.find(
    (m) =>
      m.params?.update?.sessionUpdate === "tool_call_update" &&
      m.params.update.status === "completed",
  )
  expect(completed.params.update.content[0]).toEqual({
    type: "diff",
    path: join(cwd, "a.txt"),
    oldText: null,
    newText: "hi",
  })
  expect(completed.params.update.locations[0]).toEqual({ path: join(cwd, "a.txt") })

  const finalResponse = messages.find((m) => m.id === 2)
  expect(finalResponse.result.stopReason).toBe("end_turn")
}, 20_000)


test("session/cancel mid-turn resolves stopReason cancelled without hanging", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "c1",
        name: "edit",
        input: { file_path: "b.txt", old_string: "", new_string: "hi" },
      },
      { type: "finish", reason: "tool-calls", usage: zeroUsage },
    ],
  ])
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  const promptPromise = peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create b.txt" }] },
    }),
  )

  await waitFor(() => parsed(sent).find((m) => m.method === "session/request_permission"))

  // session/cancel is a notification — no id, and MUST NOT be answered.
  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }),
  )
  await promptPromise

  const messages = parsed(sent)
  const finalResponse = messages.find((m) => m.id === 2)
  expect(finalResponse.result.stopReason).toBe("cancelled")
}, 20_000)


test("a second session/prompt while one is in flight is rejected, and the first still completes", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "edit",
      input: { file_path: "a.txt", old_string: "", new_string: "hi" },
    }),
  )
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  const first = peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create a.txt" }] },
    }),
  )
  const permissionRequest = await waitFor(() =>
    parsed(sent).find((m) => m.method === "session/request_permission"),
  )

  // ...second prompt lands while the first turn is parked on the permission.
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "and again" }] },
    }),
  )
  const rejection = parsed(sent).find((m) => m.id === 3)
  expect(rejection.error.code).toBe(-32001)
  expect(rejection.error.message).toContain(sessionId)
  expect(rejection.error.data.sessionId).toBe(sessionId)

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: permissionRequest.id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    }),
  )
  await first

  const finalResponse = parsed(sent).find((m) => m.id === 2)
  expect(finalResponse.result.stopReason).toBe("end_turn")
  expect(existsSync(join(cwd, "a.txt"))).toBe(true)
}, 20_000)


test("a permission request the client never answers times out and fails safe (deny)", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "edit",
      input: { file_path: "a.txt", old_string: "", new_string: "hi" },
    }),
  )
  const { peer, sent, logs } = makeAgent(provider, {
    model: "mock/model",
    home,
    permissionTimeoutMs: 50,
  })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  // Never answer the permission request — a live-but-silent client.
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create a.txt" }] },
    }),
  )

  const messages = parsed(sent)
  expect(messages.find((m) => m.method === "session/request_permission")).toBeDefined()
  expect(messages.find((m) => m.id === 2).result.stopReason).toBe("end_turn")
  const failed = messages.find(
    (m) =>
      m.params?.update?.sessionUpdate === "tool_call_update" && m.params.update.status === "failed",
  )
  expect(failed).toBeDefined()
  expect(logs.join("\n")).toContain("timed out")
  expect(existsSync(join(cwd, "a.txt"))).toBe(false)
}, 20_000)

test("a client disconnect denies every pending permission instead of hanging the turn", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "edit",
      input: { file_path: "a.txt", old_string: "", new_string: "hi" },
    }),
  )
  // A generous timeout, so nothing but the disconnect can resolve this ask.
  const { peer, sent, logs } = makeAgent(provider, {
    model: "mock/model",
    home,
    permissionTimeoutMs: 600_000,
  })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  const prompt = peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create a.txt" }] },
    }),
  )
  await waitFor(() => parsed(sent).find((m) => m.method === "session/request_permission"))

  // stdin EOF: the client is gone, nothing will ever answer.
  peer.abandonAll("client disconnected")
  await prompt

  expect(parsed(sent).find((m) => m.id === 2).result.stopReason).toBe("end_turn")
  expect(logs.join("\n")).toContain("client disconnected")
  expect(existsSync(join(cwd, "a.txt"))).toBe(false)
}, 20_000)


test("client-supplied mcpServers are converted, connected fail-soft, and reachable via the mcp tool", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ permissions: { "*": "allow" } }))

  const seen: Record<string, McpServerConfig>[] = []
  let closed = 0
  const provider = new MockProvider(
    oneToolCallThenText({ callId: "c1", name: "mcp", input: { op: "list" } }),
  )
  const { peer, agent, sent } = makeAgent(provider, {
    model: "mock/model",
    home,
    mcpConnect: async (configs) => {
      seen.push(configs)
      const hub = await McpHub.connect(configs, {
        transportFactory: () => {
          throw new Error("test transport")
        },
      })
      const realClose = hub.close.bind(hub)
      hub.close = async () => {
        closed += 1
        await realClose()
      }
      return hub
    },
  })

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: {
        cwd,
        mcpServers: [
          {
            name: "docs",
            command: "/path/to/mcp-server",
            args: ["--stdio"],
            env: [{ name: "TOKEN", value: "t" }],
          },
        ],
      },
    }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  expect(sessionId).toBeDefined()
  expect(seen[0]).toEqual({
    docs: { command: "/path/to/mcp-server", args: ["--stdio"], env: { TOKEN: "t" } },
  })

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "list mcp tools" }] },
    }),
  )

  const completed = parsed(sent).find(
    (m) =>
      m.params?.update?.sessionUpdate === "tool_call_update" &&
      m.params.update.toolCallId === "c1" &&
      (m.params.update.status === "completed" || m.params.update.status === "failed"),
  )
  // The mcp tool is registered for this session and its lazy L0 index is what
  // reaches the model — including the fail-soft "unavailable" marker.
  expect(JSON.stringify(completed.params.update.content)).toContain("docs")
  expect(JSON.stringify(completed.params.update.content)).toContain("unavailable")

  await agent.shutdown("test over")
  expect(closed).toBe(1)
}, 20_000)


test("with no configured permissions, bash asks (interactive posture) instead of just running", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-") // no butterfly.jsonc at all

  const provider = new MockProvider(
    // Not provably read-only (those run unasked — readonly-bash.ts).
    oneToolCallThenText({ callId: "c1", name: "bash", input: { command: "touch hi" } }),
  )
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  const prompt = peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "say hi" }] },
    }),
  )
  const permissionRequest = await waitFor(() =>
    parsed(sent).find((m) => m.method === "session/request_permission"),
  )
  expect(permissionRequest.params.toolCall.toolCallId).toBe("c1")

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: permissionRequest.id,
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
    }),
  )
  await prompt
  expect(parsed(sent).find((m) => m.id === 2).result.stopReason).toBe("end_turn")
}, 20_000)

test("butterfly.jsonc permissions override the interactive defaults entirely", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ permissions: { "*": "allow" } }))

  const provider = new MockProvider(
    oneToolCallThenText({ callId: "c1", name: "bash", input: { command: "echo hi" } }),
  )
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "say hi" }] },
    }),
  )

  const messages = parsed(sent)
  expect(messages.find((m) => m.method === "session/request_permission")).toBeUndefined()
  const completed = messages.find(
    (m) =>
      m.params?.update?.sessionUpdate === "tool_call_update" &&
      m.params.update.status === "completed",
  )
  expect(JSON.stringify(completed.params.update.content)).toContain("hi")
  expect(messages.find((m) => m.id === 2).result.stopReason).toBe("end_turn")
}, 20_000)


test("a background task from an ACP session is journalled and reaped on shutdown", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ permissions: { "*": "allow" } }))

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "bash",
      input: { command: "sleep 40", background: true },
    }),
  )
  const { peer, agent, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string

  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "start a server" }] },
    }),
  )

  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journalFile = [...new Bun.Glob("*.jsonl").scanSync({ cwd: sessionsDir })][0]
  expect(journalFile).toBeDefined()
  const events = () =>
    readFileSync(join(sessionsDir, journalFile as string), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type?: string; pid?: number; status?: string })

  // Journalled: the ACP session's registry is pre-seeded WITH its journal, not
  // lazily created without one.
  const start = events().find((e) => e.type === "bgtask.start")
  expect(start).toBeDefined()
  const pid = start?.pid as number
  bgPids.push(pid)
  expect(isAlive(pid)).toBe(true)

  await agent.shutdown("test teardown")
  await waitFor(() => (isAlive(pid) ? undefined : true), 15_000)

  expect(isAlive(pid)).toBe(false)
  const end = events().find((e) => e.type === "bgtask.end")
  expect(end?.status).toBe("killed")
}, 60_000)

test("a keepAlive background task is spared by ACP shutdown", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ permissions: { "*": "allow" } }))

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "bash",
      input: { command: "sleep 40", background: true, keepAlive: true },
    }),
  )
  const { peer, agent, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "start a server" }] },
    }),
  )

  const sessionsDir = join(cwd, ".butterfly", "sessions")
  const journalFile = [...new Bun.Glob("*.jsonl").scanSync({ cwd: sessionsDir })][0] as string
  const start = readFileSync(join(sessionsDir, journalFile), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type?: string; pid?: number; keepAlive?: boolean })
    .find((e) => e.type === "bgtask.start")
  expect(start?.keepAlive).toBe(true)
  const pid = start?.pid as number
  bgPids.push(pid)

  await agent.shutdown("test teardown")
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(isAlive(pid)).toBe(true)
}, 60_000)


test("a timed-out permission renders as a timeout, never as 'User denied'", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "edit",
      input: { file_path: "a.txt", old_string: "", new_string: "hi" },
    }),
  )
  const { peer, sent } = makeAgent(provider, {
    model: "mock/model",
    home,
    permissionTimeoutMs: 50,
  })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create a.txt" }] },
    }),
  )

  const wire = JSON.stringify(parsed(sent))
  expect(wire).toContain("timed out")
  expect(wire).not.toContain("User denied")
  const request = provider.requests[provider.requests.length - 1]
  const toolMessage = request?.messages.find((m) => m.role === "tool")
  expect(toolMessage && "output" in toolMessage ? toolMessage.output : "").toContain("timed out")
  expect(toolMessage && "output" in toolMessage ? toolMessage.output : "").not.toContain(
    "User denied",
  )
}, 20_000)

test("a client disconnect is reported as a disconnect, not as a user decision", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "edit",
      input: { file_path: "a.txt", old_string: "", new_string: "hi" },
    }),
  )
  const { peer, sent } = makeAgent(provider, {
    model: "mock/model",
    home,
    permissionTimeoutMs: 600_000,
  })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  const prompt = peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create a.txt" }] },
    }),
  )
  await waitFor(() => parsed(sent).find((m) => m.method === "session/request_permission"))
  peer.abandonAll("client disconnected")
  await prompt

  const wire = JSON.stringify(parsed(sent))
  expect(wire).toContain("client disconnected")
  expect(wire).not.toContain("User denied")
}, 20_000)

test("an explicit Reject from the client still reads as the user's decision", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({ permissions: { "*": "allow", edit: "ask" } }),
  )

  const provider = new MockProvider(
    oneToolCallThenText({
      callId: "c1",
      name: "edit",
      input: { file_path: "a.txt", old_string: "", new_string: "hi" },
    }),
  )
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  const prompt = peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "create a.txt" }] },
    }),
  )
  const ask = await waitFor(() =>
    parsed(sent).find((m) => m.method === "session/request_permission"),
  )
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: ask.id,
      result: { outcome: { outcome: "selected", optionId: "reject-once" } },
    }),
  )
  await prompt

  const wire = JSON.stringify(parsed(sent))
  expect(wire).toContain("User denied")
  expect(wire).not.toContain("never answered")
  expect(existsSync(join(cwd, "a.txt"))).toBe(false)
}, 20_000)


/** A classified-retryable stream failure with a ZERO backoff, so the retry
 * path runs instantly instead of sleeping out a jittered 0-2s ceiling. */
function retryableFailure(message = "overloaded"): TurnEvent[] {
  return [
    {
      type: "error",
      message,
      info: { kind: "unavailable", message, retryAfterSec: 0 },
    },
  ]
}

test("butterfly.jsonc `retries: 0` reaches the runner — a retryable failure is NOT retried", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ retries: 0 }))

  // Two scripts available; a correctly-wired retries:0 consumes only one.
  const provider = new MockProvider([
    retryableFailure(),
    [
      { type: "text-delta", text: "recovered" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ])
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "go" }] },
    }),
  )

  expect(provider.requests.length).toBe(1)
  const response = parsed(sent).find((m) => m.id === 2)
  expect(response.error.message).toContain("overloaded")
}, 20_000)

test("butterfly.jsonc `retries: 1` reaches the runner — exactly one retry, then success", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ retries: 1 }))

  const provider = new MockProvider([
    retryableFailure(),
    [
      { type: "text-delta", text: "recovered" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ])
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "go" }] },
    }),
  )

  expect(provider.requests.length).toBe(2)
  const response = parsed(sent).find((m) => m.id === 2)
  expect(response.result.stopReason).toBe("end_turn")
}, 20_000)

test("a retried step marks the doomed attempt's tool_call card failed instead of leaving it in_progress", async () => {
  const home = tempDir("bfly-acp-home-")
  const cwd = gitCwd("bfly-acp-cwd-")
  writeFileSync(join(cwd, "butterfly.jsonc"), JSON.stringify({ permissions: { "*": "allow" } }))

  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "ghost", name: "read", input: { file_path: "a.txt" } },
      {
        type: "error",
        message: "overloaded",
        info: { kind: "unavailable", message: "overloaded", retryAfterSec: 0 },
      },
    ],
    [
      { type: "text-delta", text: "recovered" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ])
  const { peer, sent } = makeAgent(provider, { model: "mock/model", home })

  await peer.handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd } }),
  )
  const sessionId = parsed(sent)[0].result.sessionId as string
  await peer.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "read it" }] },
    }),
  )

  const updates = parsed(sent)
    .filter((m) => m.method === "session/update")
    .map((m) => m.params.update)
  const ghostUpdates = updates.filter((u) => u.toolCallId === "ghost")
  expect(ghostUpdates.length).toBeGreaterThanOrEqual(3)
  expect(ghostUpdates.at(-1).status).toBe("failed")
  const response = parsed(sent).find((m) => m.id === 2)
  expect(response.result.stopReason).toBe("end_turn")
}, 20_000)
