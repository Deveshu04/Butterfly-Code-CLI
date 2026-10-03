import { afterAll, expect, test } from "bun:test"
import { createAnthropic } from "@ai-sdk/anthropic"
import { AiSdkProvider, withAnthropicCacheBreakpoints } from "../src/provider/aisdk-adapter"

/**
 * Rolling cache breakpoints, asserted on the REAL wire body the Anthropic
 * SDK produces against a fake Messages API — not on our intent.
 */
let captured: Record<string, unknown> | undefined
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    captured = (await request.json()) as Record<string, unknown>
    const events = [
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          content: [],
          model: "x",
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      {
        headers: { "content-type": "text/event-stream" },
      },
    )
  },
})
afterAll(() => server.stop(true))

test("only the last message and the previous user-side message are marked", () => {
  const marked = withAnthropicCacheBreakpoints([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
    { role: "assistant", content: "d" },
    { role: "user", content: "e" },
  ])
  const flags = marked.map((m) => Boolean(m.providerOptions?.["anthropic"]))
  expect(flags).toEqual([false, false, true, false, true])
  expect(withAnthropicCacheBreakpoints([])).toEqual([])
})

test("the Anthropic wire body carries cache_control on the system prefix and the rolling breakpoints", async () => {
  const anthropic = createAnthropic({ baseURL: `http://localhost:${server.port}/v1`, apiKey: "k" })
  const provider = new AiSdkProvider(() => ({
    model: anthropic("claude-test"),
    providerId: "anthropic",
  }))
  for await (const _ of provider.streamTurn({
    model: "anthropic/claude-test",
    messages: [
      { role: "system", content: "prefix" },
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ callId: "t1", name: "read", input: { file_path: "a" } }],
      },
      { role: "tool", callId: "t1", name: "read", output: "contents" },
    ],
    tools: [{ name: "read", description: "r", inputSchema: { type: "object", properties: {} } }],
  })) {
    // drain
  }
  const body = JSON.stringify(captured)
  // system + the last (tool result) message + the previous user message.
  expect(body.match(/"cache_control":\{"type":"ephemeral"\}/g)?.length).toBe(3)
  const messages = (captured?.["messages"] ?? []) as {
    role: string
    content: { cache_control?: unknown }[]
  }[]
  expect(messages.at(-1)?.content.at(-1)?.cache_control).toEqual({ type: "ephemeral" })
})
