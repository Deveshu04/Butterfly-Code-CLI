import { expect, test } from "bun:test"
import { formatToolResult, stripThink } from "../src/format"

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
