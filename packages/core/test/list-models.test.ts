import { expect, test } from "bun:test"
import { fetchProviderModels } from "../src/provider/list-models"

function stub(payload: unknown, capture?: { url?: string; headers?: unknown }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url)
      capture.headers = init?.headers
    }
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
}

test("openrouter list is public and carries context_length", async () => {
  const capture: { url?: string } = {}
  const models = await fetchProviderModels("openrouter", {
    fetchFn: stub(
      { data: [{ id: "qwen/qwen3-coder", name: "Qwen3 Coder", context_length: 262144 }] },
      capture,
    ),
  })
  expect(models).toEqual([{ id: "qwen/qwen3-coder", name: "Qwen3 Coder", context: 262144 }])
  expect(capture.url).toContain("openrouter.ai/api/v1/models")
})

test("anthropic list sends x-api-key and maps display_name", async () => {
  const capture: { headers?: unknown } = {}
  const models = await fetchProviderModels("anthropic", {
    apiKey: "sk-ant",
    fetchFn: stub(
      {
        data: [
          { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", max_input_tokens: 200000 },
        ],
      },
      capture,
    ),
  })
  expect(models[0]).toEqual({ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: 200000 })
  expect((capture.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant")
})

test("google filters to generateContent models and strips the prefix", async () => {
  const models = await fetchProviderModels("google", {
    apiKey: "g-key",
    fetchFn: stub({
      models: [
        {
          name: "models/gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          inputTokenLimit: 1048576,
          supportedGenerationMethods: ["generateContent"],
        },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    }),
  })
  expect(models).toEqual([{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", context: 1048576 }])
})

test("openai list filters non-chat models", async () => {
  const models = await fetchProviderModels("openai", {
    apiKey: "sk",
    fetchFn: stub({
      data: [{ id: "gpt-5-mini" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }],
    }),
  })
  expect(models.map((m) => m.id)).toEqual(["gpt-5-mini"])
})

test("failures return an empty list, never throw", async () => {
  const failing = (async () => {
    throw new Error("offline")
  }) as unknown as typeof fetch
  expect(await fetchProviderModels("openrouter", { fetchFn: failing })).toEqual([])
  expect(await fetchProviderModels("unknown-provider", {})).toEqual([])
})
