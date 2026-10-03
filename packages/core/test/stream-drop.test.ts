import { afterAll, expect, test } from "bun:test"
import { AiSdkProvider } from "../src/provider/aisdk-adapter"
import { createModelResolver } from "../src/provider/hub"
import type { TurnEvent } from "../src/provider/port"

/**
 * A response stream that just ENDS (proxy idle cut, server restart mid-SSE)
 * must surface as a retryable network error — not a clean finish that ends
 * the turn on half an answer.
 */
const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" }
const chunk = (c: unknown) => `data: ${JSON.stringify(c)}\n\n`
let mode: "drop" | "complete" = "drop"
let finishReason = "stop"

const server = Bun.serve({
  port: 0,
  async fetch() {
    const head = chunk({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "half an ans" } }],
    })
    const body =
      mode === "drop"
        ? head
        : `${head}${chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}${chunk({ ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}data: [DONE]\n\n`
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  },
})
afterAll(() => server.stop(true))

async function turn(signal?: AbortSignal): Promise<TurnEvent[]> {
  const provider = new AiSdkProvider(
    createModelResolver(
      { providers: { sarvam: { baseURL: `http://localhost:${server.port}/v1` } } },
      { SARVAM_API_KEY: "k" },
    ),
  )
  const events: TurnEvent[] = []
  for await (const event of provider.streamTurn({
    model: "sarvam/sarvam-105b",
    messages: [{ role: "user", content: "hi" }],
    ...(signal ? { signal } : {}),
  })) {
    events.push(event)
  }
  return events
}

test("a stream that ends without the provider's finish is a retryable network error", async () => {
  mode = "drop"
  const events = await turn()
  const last = events.at(-1)
  expect(last?.type).toBe("error")
  if (last?.type === "error") {
    expect(last.info?.kind).toBe("network")
    expect(last.info?.message).toContain("connection dropped")
  }
  expect(events.some((e) => e.type === "finish")).toBe(false)
})

test("a complete stream still finishes cleanly", async () => {
  mode = "complete"
  const events = await turn()
  expect(events.at(-1)).toEqual({
    type: "finish",
    reason: "stop",
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
  })
})

test("vendor spellings of 'cut off at the output cap' arrive as length, not error", async () => {
  mode = "complete"
  for (const raw of ["max_tokens", "MAX_TOKENS", "max_output_tokens", "model_length"]) {
    finishReason = raw
    const events = await turn()
    const last = events.at(-1)
    expect(last?.type === "finish" ? last.reason : undefined).toBe("length")
  }
  finishReason = "something_else"
  const events = await turn()
  const last = events.at(-1)
  expect(last?.type === "finish" ? last.reason : undefined).toBe("error")
  finishReason = "stop"
})
