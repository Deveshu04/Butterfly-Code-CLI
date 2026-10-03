import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AiSdkProvider } from "../src/provider/aisdk-adapter"
import {
  createModelResolver,
  normalizeGatewayBase,
  presetBaseURL,
  presetEnvKey,
  SELF_NAMED_PROVIDERS,
} from "../src/provider/hub"
import { fetchProviderModels } from "../src/provider/list-models"
import { ModelsCatalog } from "../src/provider/models-catalog"

/** A stand-in LiteLLM proxy: chat completions, /model/info, /v1/models. */
const seen: { path: string; auth: string | null; model?: unknown }[] = []
/** Override for /model/info: status + body (null = the default listing). */
let modelInfo: { status: number; body: string } | null = null
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    seen.push({ path: url.pathname, auth: request.headers.get("authorization") })
    if (url.pathname === "/model/info") {
      return (
        (modelInfo ? new Response(modelInfo.body, { status: modelInfo.status }) : null) ??
        json({
          data: [
            { model_name: "gpt-4o", model_info: { max_input_tokens: 128_000 } },
            { model_name: "gpt-4o", model_info: { max_input_tokens: 128_000 } }, // 2nd deployment
            { model_name: "claude-sonnet", model_info: { max_tokens: 200_000 } },
          ],
        })
      )
    }
    if (url.pathname === "/v1/models") return json({ data: [{ id: "only-id" }] })
    if (url.pathname === "/v1/chat/completions") {
      const body = (await request.json()) as { model: unknown }
      const last = seen.at(-1)
      if (last) last.model = body.model
      const chunk = { id: "x", object: "chat.completion.chunk", created: 0, model: "gpt-4o" }
      return new Response(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: "hi from the proxy" } }] })}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return new Response("not found", { status: 404 })
  },
})
afterAll(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}`

test("litellm is a preset: LITELLM_API_KEY, default localhost:4000/v1, LITELLM_BASE_URL override", () => {
  expect(presetEnvKey("litellm")).toBe("LITELLM_API_KEY")
  expect(presetBaseURL("litellm", {})).toBe("http://localhost:4000/v1")
  expect(presetBaseURL("litellm", { LITELLM_BASE_URL: "https://llm.corp.example" })).toBe(
    "https://llm.corp.example/v1",
  )
  expect(normalizeGatewayBase("http://h:4000/v1/")).toBe("http://h:4000/v1")
  expect(SELF_NAMED_PROVIDERS.has("litellm")).toBe(true)
})

test("a turn goes through the proxy at LITELLM_BASE_URL with the virtual key, model id untouched", async () => {
  seen.length = 0
  const provider = new AiSdkProvider(
    createModelResolver({}, { LITELLM_BASE_URL: base, LITELLM_API_KEY: "sk-litellm-virtual" }),
  )
  let text = ""
  for await (const event of provider.streamTurn({
    model: "litellm/anthropic/claude-sonnet",
    messages: [{ role: "user", content: "hello" }],
  })) {
    if (event.type === "text-delta") text += event.text
  }
  expect(text).toBe("hi from the proxy")
  const call = seen.find((s) => s.path === "/v1/chat/completions")
  expect(call?.auth).toBe("Bearer sk-litellm-virtual")
  // Everything after "litellm/" is the proxy's model_name, slashes included.
  expect(call?.model).toBe("anthropic/claude-sonnet")
})

test("model listing reads /model/info (context, one row per alias), falling back to /v1/models", async () => {
  const models = await fetchProviderModels("litellm", { baseURL: `${base}/v1`, apiKey: "k" })
  expect(models).toEqual([
    { id: "gpt-4o", context: 128_000 },
    { id: "claude-sonnet", context: 200_000 },
  ])
  modelInfo = { status: 403, body: "forbidden" }
  const fallback = await fetchProviderModels("litellm", { baseURL: `${base}/v1` })
  expect(fallback).toEqual([{ id: "only-id" }])
  modelInfo = null
})

test("catalog resolves gateway model ids to the underlying vendor's limits + pricing", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "bfly-litellm-cat-")), "cache.json")
  writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: Date.now(),
      data: {
        openai: {
          models: { "gpt-4o": { limit: { context: 128_000 }, cost: { input: 2.5, output: 10 } } },
        },
        anthropic: { models: { "claude-sonnet-4-6": { limit: { context: 200_000 } } } },
      },
    }),
  )
  const catalog = await ModelsCatalog.load({ cachePath, cacheOnly: true })
  expect(catalog.lookup("litellm", "gpt-4o")?.cost?.input).toBe(2.5)
  expect(catalog.lookup("litellm", "openai/gpt-4o")?.context).toBe(128_000)
  expect(catalog.lookup("litellm", "anthropic/claude-sonnet-4-6")?.context).toBe(200_000)
  expect(catalog.lookup("litellm", "my-private-alias")).toBeUndefined()
  // Non-gateway providers never borrow another vendor's entry.
  expect(catalog.lookup("openrouter", "gpt-4o")).toBeUndefined()
})
