import { expect, test } from "bun:test"
import { DEFAULT_MODEL_OUTPUT_CHARS, settle } from "../src/tool/settle"

test("short output passes through untouched", () => {
  const result = settle("hello\nworld\n")
  expect(result).toEqual({
    text: "hello\nworld\n",
    truncated: false,
    originalChars: 12,
    originalLines: 2,
  })
})

test("long output is elided head+tail within the budget", () => {
  const raw = "x".repeat(100_000)
  const result = settle(raw)
  expect(result.truncated).toBe(true)
  expect(result.text.length).toBeLessThanOrEqual(DEFAULT_MODEL_OUTPUT_CHARS)
  expect(result.text).toContain("elided")
  expect(result.originalChars).toBe(100_000)
})

test("head and tail content are both preserved", () => {
  const raw = `HEAD-MARKER\n${"m".repeat(50_000)}\nTAIL-MARKER`
  const result = settle(raw, { maxChars: 1_000 })
  expect(result.text.startsWith("HEAD-MARKER")).toBe(true)
  expect(result.text.endsWith("TAIL-MARKER")).toBe(true)
  expect(result.text.length).toBeLessThanOrEqual(1_000)
})

test("custom head ratio shifts the split", () => {
  const raw = `${"a".repeat(500)}${"b".repeat(500)}`
  const result = settle(raw, { maxChars: 100, headRatio: 0.9 })
  const aCount = (result.text.match(/a/g) ?? []).length
  const bCount = (result.text.match(/b/g) ?? []).length
  expect(aCount).toBeGreaterThan(bCount)
})
