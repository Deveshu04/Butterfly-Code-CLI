import { expect, test } from "bun:test"
import {
  ollamaApiRoot,
  probeOllamaContext,
  servedContextWarning,
} from "../src/provider/local-context"

function fakeFetch(body: unknown, status = 200): { fn: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const fn = (async (url: string | URL) => {
    urls.push(String(url))
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, urls }
}

const ps = {
  models: [
    { name: "qwen3:8b", model: "qwen3:8b", context_length: 4096 },
    { name: "llama3.2:latest", model: "llama3.2:latest", context_length: 32768 },
  ],
}

test("the API root drops the OpenAI-compatible /v1 suffix", () => {
  expect(ollamaApiRoot("http://localhost:11434/v1")).toBe("http://localhost:11434")
  expect(ollamaApiRoot("http://box:11434/v1/")).toBe("http://box:11434")
  expect(ollamaApiRoot("http://box:11434")).toBe("http://box:11434")
})

test("the probe reads the loaded model's served context from /api/ps", async () => {
  const { fn, urls } = fakeFetch(ps)
  expect(await probeOllamaContext("http://localhost:11434/v1", "qwen3:8b", fn)).toBe(4096)
  expect(urls).toEqual(["http://localhost:11434/api/ps"])
  // An untagged ref matches the :latest entry.
  expect(await probeOllamaContext("http://localhost:11434/v1", "llama3.2", fn)).toBe(32768)
})

test("unloaded models, old servers without the field, and errors all probe as unknown", async () => {
  expect(await probeOllamaContext("http://x/v1", "mistral", fakeFetch(ps).fn)).toBeUndefined()
  expect(
    await probeOllamaContext(
      "http://x/v1",
      "qwen3:8b",
      fakeFetch({ models: [{ name: "qwen3:8b" }] }).fn,
    ),
  ).toBeUndefined()
  expect(await probeOllamaContext("http://x/v1", "qwen3:8b", fakeFetch({}, 500).fn)).toBeUndefined()
  const throwing = (async () => {
    throw new Error("ECONNREFUSED")
  }) as unknown as typeof fetch
  expect(await probeOllamaContext("http://x/v1", "qwen3:8b", throwing)).toBeUndefined()
})

test("warns only when the served context cannot hold the prefix plus a working margin", () => {
  const warning = servedContextWarning("qwen3:8b", 4096, 3_500)
  expect(warning).toContain("4,096-token context")
  expect(warning).toContain("OLLAMA_CONTEXT_LENGTH")
  expect(servedContextWarning("qwen3:8b", 32_768, 3_500)).toBeUndefined()
})
