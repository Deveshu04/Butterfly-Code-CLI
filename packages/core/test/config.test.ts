import { expect, test } from "bun:test"
import { ButterflyConfig, mergeConfigs, parseJsonc, substituteEnv } from "../src/config/config"

test("parseJsonc strips line and block comments", () => {
  const text = `{
  // the model to use
  "model": "openrouter/foo", /* inline */
  "small_model": "openrouter/bar"
}`
  expect(parseJsonc(text)).toEqual({ model: "openrouter/foo", small_model: "openrouter/bar" })
})

test("parseJsonc tolerates trailing commas", () => {
  const text = `{ "a": [1, 2, 3,], "b": { "c": 1, }, }`
  expect(parseJsonc(text)).toEqual({ a: [1, 2, 3], b: { c: 1 } })
})

test("parseJsonc leaves comment-like content inside strings alone", () => {
  const text = `{ "url": "https://example.com/x", "note": "a // not a comment /* neither */" }`
  expect(parseJsonc(text)).toEqual({
    url: "https://example.com/x",
    note: "a // not a comment /* neither */",
  })
})

test("substituteEnv replaces placeholders in nested strings", () => {
  const input = { providers: { openrouter: { apiKey: "{env:OR_KEY}", baseURL: "https://x" } } }
  const output = substituteEnv(input, { OR_KEY: "sk-123" })
  expect(output).toEqual({ providers: { openrouter: { apiKey: "sk-123", baseURL: "https://x" } } })
})

test("substituteEnv leaves unknown vars as empty string", () => {
  expect(substituteEnv({ k: "{env:NOPE}" }, {})).toEqual({ k: "" })
})

test("mergeConfigs merges nested objects with override winning on scalars", () => {
  const base = {
    model: "a",
    providers: { openrouter: { baseURL: "b1" }, ollama: { baseURL: "o" } },
  }
  const override = { model: "c", providers: { openrouter: { apiKey: "k" } } }
  expect(mergeConfigs(base, override)).toEqual({
    model: "c",
    providers: { openrouter: { baseURL: "b1", apiKey: "k" }, ollama: { baseURL: "o" } },
  })
})

test("ButterflyConfig validates a realistic config", () => {
  const parsed = ButterflyConfig.parse({
    model: "openrouter/deepseek/deepseek-chat-v3",
    permissions: { "*": "ask", bash: { "git *": "allow" } },
    providers: { openrouter: { apiKey: "sk" } },
  })
  expect(parsed.model).toContain("deepseek")
})


test("ButterflyConfig accepts an optional non-negative integer `retries`", () => {
  expect(ButterflyConfig.parse({ retries: 5 }).retries).toBe(5)
  expect(ButterflyConfig.parse({ retries: 0 }).retries).toBe(0)
  expect(ButterflyConfig.parse({}).retries).toBeUndefined()
})

test("ButterflyConfig rejects a negative or non-integer `retries`", () => {
  expect(() => ButterflyConfig.parse({ retries: -1 })).toThrow()
  expect(() => ButterflyConfig.parse({ retries: 1.5 })).toThrow()
})
