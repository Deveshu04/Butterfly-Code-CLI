import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { AiSdkProvider } from "../src/provider/aisdk-adapter"
import { createModelResolver } from "../src/provider/hub"
import type { TurnEvent } from "../src/provider/port"
import { assemble } from "../src/session/assembly"
import { now, type SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider, zeroUsage } from "./helpers/mock-provider"

const t = now()

test("the runner journals reasoning only for steps that made tool calls", async () => {
  const registry = new ToolRegistry()
  registry.register({
    name: "look",
    description: "l",
    inputSchema: z.object({}),
    execute: async () => ({ output: "seen" }),
  })
  const provider = new MockProvider([
    [
      { type: "reasoning-delta", text: "I should look first." },
      { type: "tool-call", callId: "c1", name: "look", input: {} },
      { type: "finish", reason: "tool-calls", usage: zeroUsage },
    ],
    [
      { type: "reasoning-delta", text: "Now answer." },
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: zeroUsage },
    ],
  ] as TurnEvent[][])
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-reasoning-")))
  await runUserTurn(
    { provider, registry, journal, rules: { "*": "allow" }, model: "m", system: "s", cwd: "/w" },
    "go",
  )
  const steps = SessionJournal.replay(journal.path).events.filter(
    (e) => e.type === "message.assistant",
  )
  expect(steps.map((e) => (e.type === "message.assistant" ? e.reasoning : "x"))).toEqual([
    "I should look first.",
    undefined,
  ])
})

test("assembly sends reasoning back only for the current turn", () => {
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "old", time: t },
    { type: "message.assistant", id: "a1", text: "", reasoning: "old thoughts", time: t },
    { type: "tool.call", callId: "c1", name: "look", input: {}, time: t },
    { type: "tool.result", callId: "c1", output: "x", isError: false, time: t },
    { type: "message.user", id: "u2", text: "new", time: t },
    { type: "message.assistant", id: "a2", text: "", reasoning: "new thoughts", time: t },
    { type: "tool.call", callId: "c2", name: "look", input: {}, time: t },
    { type: "tool.result", callId: "c2", output: "y", isError: false, time: t },
  ]
  const assistants = assemble({ system: "s", timeline }).filter((m) => m.role === "assistant")
  expect(assistants.map((m) => (m.role === "assistant" ? m.reasoning : "x"))).toEqual([
    undefined,
    "new thoughts",
  ])
})

let body: Record<string, unknown> | undefined
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    body = (await request.json()) as Record<string, unknown>
    const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "m" }
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]
    return new Response(
      `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    )
  },
})
afterAll(() => server.stop(true))

test("OpenAI-compatible wire: the tool-calling assistant message carries reasoning_content", async () => {
  const provider = new AiSdkProvider(
    createModelResolver(
      { providers: { thinker: { baseURL: `http://localhost:${server.port}/v1` } } },
      {},
    ),
  )
  for await (const _ of provider.streamTurn({
    model: "thinker/deep-model",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        reasoning: "I should look first.",
        toolCalls: [{ callId: "c1", name: "look", input: {} }],
      },
      { role: "tool", callId: "c1", name: "look", output: "seen" },
    ],
    tools: [{ name: "look", description: "l", inputSchema: { type: "object", properties: {} } }],
  })) {
    // drain
  }
  const messages = (body?.["messages"] ?? []) as { role: string; reasoning_content?: string }[]
  expect(messages.find((m) => m.role === "assistant")?.reasoning_content).toBe(
    "I should look first.",
  )
})
