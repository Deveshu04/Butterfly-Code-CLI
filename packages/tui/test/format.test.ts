import { expect, test } from "bun:test"
import { formatCommandBody, formatToolResult, splitThink, stripThink } from "../src/format"

test("closed think blocks disappear, keeping the answer", () => {
  expect(stripThink("<think>\nreasoning here\n</think>\nThe answer is 4")).toBe("The answer is 4")
  expect(stripThink("plain text")).toBe("plain text")
})

test("an unterminated think block truncates cleanly mid-stream", () => {
  expect(stripThink("Partial <think>still going")).toBe("Partial ")
})

test("tool results show more lines for errors than successes", () => {
  const output = "line1\nline2\nline3\nline4\nline5\nline6\nline7"
  const ok = formatToolResult(output, false)
  const err = formatToolResult(output, true)
  expect(ok).toContain("line2")
  expect(ok).not.toContain("line3")
  expect(ok).toContain("5 more")
  expect(err).toContain("line5")
  expect(err).toContain("2 more")
})


test("splitThink extracts a closed think block's inner text and leaves the answer as rest", () => {
  const result = splitThink("<think>\nreasoning here\n</think>\nThe answer is 4")
  expect(result.rest).toBe("The answer is 4")
  expect(result.thinking.trim()).toBe("reasoning here")
  expect(result.open).toBe(false)
})

test("splitThink treats an unterminated think block as still-streaming (open)", () => {
  const result = splitThink("Partial <think>still going")
  expect(result.rest).toBe("Partial ")
  expect(result.thinking).toBe("still going")
  expect(result.open).toBe(true)
})

test("splitThink with no think tags at all returns the text unchanged and no thinking", () => {
  const result = splitThink("plain text")
  expect(result.rest).toBe("plain text")
  expect(result.thinking).toBe("")
  expect(result.open).toBe(false)
})

test("stripThink stays byte-identical to splitThink(text).rest (regression pin)", () => {
  const samples = [
    "<think>\nreasoning here\n</think>\nThe answer is 4",
    "Partial <think>still going",
    "plain text",
  ]
  for (const sample of samples) {
    expect(stripThink(sample)).toBe(splitThink(sample).rest)
  }
})


test("formatCommandBody has no leading icon and no per-line indent, unlike formatToolResult", () => {
  const output = "line1\nline2"
  const body = formatCommandBody(output, false)
  expect(body).not.toContain("✓")
  expect(body).not.toContain("✗")
  expect(body).toBe("line1\nline2")
})

test("formatCommandBody shows more lines for a failing command, matching formatToolResult's cap", () => {
  const output = "l1\nl2\nl3\nl4\nl5\nl6\nl7"
  const body = formatCommandBody(output, true)
  expect(body).toContain("l5")
  expect(body).not.toContain("l6")
  expect(body).toContain("2 more")
})
