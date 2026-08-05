import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProviderPort, TurnEvent, TurnRequest, Usage } from "@butterfly/core"
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

function makeAgent(provider: ProviderPort, opts: { model?: string; home: string }) {
  const sent: string[] = []
  const peer = connectAcpAgent(
    (line) => {
      sent.push(line)
    },
    {
      provider,
      ...(opts.model ? { model: opts.model } : {}),
      home: opts.home,
    },
  )
  return { peer, sent }
}

// biome-ignore lint/suspicious/noExplicitAny: test-only JSON-RPC frame inspection
function parsed(sent: string[]): any[] {
  return sent.map((line) => JSON.parse(line))
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
