import { afterAll, expect, test } from "bun:test"
import { AiSdkProvider } from "../src/provider/aisdk-adapter"
import { createModelResolver } from "../src/provider/hub"
import type { TurnEvent } from "../src/provider/port"

/** Arguments streamed in pieces, like a model writing a big edit. */
const base = { id: "c", object: "chat.completion.chunk", created: 0, model: "m" }
const server = Bun.serve({
  port: 0,
  fetch() {
    const call = (args: string, first: boolean) => ({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            ...(first ? { role: "assistant" } : {}),
            tool_calls: [
              first
                ? {
                    index: 0,
                    id: "call_9",
                    type: "function",
                    function: { name: "edit", arguments: args },
                  }
                : { index: 0, function: { arguments: args } },
            ],
          },
        },
      ],
    })
    const chunks = [
      call('{"file_path":"a.ts",', true),
      call('"old_string":"",', false),
      call('"new_string":"x"}', false),
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
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

test("a tool call announces itself (tool-input-start) before its arguments are complete", async () => {
  const provider = new AiSdkProvider(
    createModelResolver(
      { providers: { fake: { baseURL: `http://localhost:${server.port}/v1` } } },
      {},
    ),
  )
  const events: TurnEvent[] = []
  for await (const event of provider.streamTurn({
    model: "fake/m",
    messages: [{ role: "user", content: "edit" }],
    tools: [{ name: "edit", description: "e", inputSchema: { type: "object", properties: {} } }],
  })) {
    events.push(event)
  }
  const kinds = events.map((e) => e.type)
  const start = kinds.indexOf("tool-input-start")
  expect(start).toBeGreaterThanOrEqual(0)
  expect(start).toBeLessThan(kinds.indexOf("tool-call"))
  expect(events[start]).toEqual({ type: "tool-input-start", callId: "call_9", name: "edit" })
})
