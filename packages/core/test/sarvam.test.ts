import { afterAll, expect, test } from "bun:test"
import { AiSdkProvider } from "../src/provider/aisdk-adapter"
import { classifyProviderError } from "../src/provider/describe-error"
import { createModelResolver, normalizeSarvamBody, presetEnvKey } from "../src/provider/hub"
import { fetchProviderModels } from "../src/provider/list-models"
import { ModelsCatalog } from "../src/provider/models-catalog"
import type { ReasoningEffort, TurnEvent } from "../src/provider/port"


interface Captured {
  body: Record<string, unknown>
  headers: Headers
}
const captured: Captured[] = []
let nextStatus = 200
let nextErrorBody: unknown = null

const sse = (chunks: unknown[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Record<string, unknown>
    captured.push({ body, headers: request.headers })
    if (nextStatus !== 200) {
      return new Response(JSON.stringify(nextErrorBody), {
        status: nextStatus,
        headers: { "content-type": "application/json" },
      })
    }
    const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "sarvam-105b" }
    return new Response(
      sse([
        {
          ...base,
          choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hmm" } }],
        },
        { ...base, choices: [{ index: 0, delta: { content: "namaste" } }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        {
          ...base,
          choices: [],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        },
      ]),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
afterAll(() => server.stop(true))

function provider() {
  return new AiSdkProvider(
    createModelResolver(
      { providers: { sarvam: { baseURL: `http://localhost:${server.port}/v1` } } },
      { SARVAM_API_KEY: "sk-sarvam-test" },
    ),
  )
}

async function turn(reasoning?: ReasoningEffort, toolOutput?: string): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  for await (const event of provider().streamTurn({
    model: "sarvam/sarvam-105b",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      ...(toolOutput !== undefined
        ? [
            {
              role: "assistant" as const,
              content: "",
              toolCalls: [{ callId: "t1", name: "bash", input: { command: "true" } }],
            },
            { role: "tool" as const, callId: "t1", name: "bash", output: toolOutput },
          ]
        : []),
    ],
    ...(reasoning ? { reasoning } : {}),
  })) {
    events.push(event)
  }
  return events
}

test("sarvam is a preset: SARVAM_API_KEY, Bearer AND api-subscription-key headers", async () => {
  expect(presetEnvKey("sarvam")).toBe("SARVAM_API_KEY")
  captured.length = 0
  await turn()
  const request = captured.at(-1)
  expect(request?.headers.get("authorization")).toBe("Bearer sk-sarvam-test")
  expect(request?.headers.get("api-subscription-key")).toBe("sk-sarvam-test")
  expect(request?.body["model"]).toBe("sarvam-105b")
})

test("streams reasoning_content as reasoning and content as text, with usage", async () => {
  const events = await turn("medium")
  expect(
    events.filter((e) => e.type === "reasoning-delta").map((e) => (e as { text: string }).text),
  ).toEqual(["hmm"])
  expect(
    events.filter((e) => e.type === "text-delta").map((e) => (e as { text: string }).text),
  ).toEqual(["namaste"])
  const finish = events.find((e) => e.type === "finish")
  expect(finish && finish.type === "finish" ? finish.usage.input : 0).toBe(11)
})

test("reasoning levels map onto Sarvam's low|medium|high|null on the wire", async () => {
  const cases: [ReasoningEffort, unknown][] = [
    ["none", null],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "high"],
  ]
  for (const [level, wire] of cases) {
    captured.length = 0
    await turn(level)
    const body = captured.at(-1)?.body ?? {}
    expect("reasoning_effort" in body).toBe(true)
    expect(body["reasoning_effort"]).toBe(wire as never)
  }
})

test("a blank tool result never reaches Sarvam as whitespace-only content", async () => {
  captured.length = 0
  await turn(undefined, "   \n")
  const messages = captured.at(-1)?.body["messages"] as { role: string; content: unknown }[]
  const tool = messages.find((m) => m.role === "tool")
  expect(tool?.content).toBe("(no output)")
})

test("normalizeSarvamBody: developer role, max_completion_tokens, unknown effort", () => {
  const out = normalizeSarvamBody({
    messages: [{ role: "developer", content: "x" }],
    max_completion_tokens: 100,
    reasoning_effort: "bogus",
  })
  expect((out["messages"] as { role: string }[])[0]?.role).toBe("system")
  expect(out["max_tokens"]).toBe(100)
  expect("max_completion_tokens" in out).toBe(false)
  expect("reasoning_effort" in out).toBe(false)
})

test("Sarvam's error bodies classify into the taxonomy", async () => {
  const cases: [number, unknown, string][] = [
    [402, { message: "No credits available.", code: "insufficient_quota_error" }, "quota"],
    [
      403,
      { message: "Invalid or missing authentication credentials", code: "invalid_api_key_error" },
      "auth",
    ],
    [422, { message: "Input exceeds the model context window of 128000 tokens" }, "context_length"],
  ]
  for (const [status, body, kind] of cases) {
    nextStatus = status
    nextErrorBody = body
    const events = await turn()
    const error = events.find((e) => e.type === "error")
    expect(error && error.type === "error" ? error.info?.kind : "none").toBe(kind as never)
    expect(classifyProviderError(body).kind).toBe(kind as never)
  }
  nextStatus = 200
})

test("catalog knows Sarvam models offline (limits + pricing), snapshot still wins", () => {
  const empty = ModelsCatalog.empty()
  const entry = empty.lookup("sarvam", "sarvam-105b")
  expect(entry?.context).toBe(128_000)
  expect(entry?.toolCall).toBe(true)
  expect(entry?.cost?.input).toBeGreaterThan(0)
  expect(empty.listModels("sarvam").map((m) => m.id)).toContain("sarvam-105b")
})

test("model listing falls back to the known Sarvam lineup when /models is unavailable", async () => {
  const fetchFn = (async () =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch
  const models = await fetchProviderModels("sarvam", { apiKey: "k", fetchFn })
  expect(models.map((m) => m.id)).toContain("sarvam-105b")
  expect(models.find((m) => m.id === "sarvam-105b")?.context).toBe(128_000)
})
