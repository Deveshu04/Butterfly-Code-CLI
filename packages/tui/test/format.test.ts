import { expect, test } from "bun:test"
import { OSC52_TEXT_CAP_BYTES, osc52CapLabel } from "../src/clipboard"
import {
  COPY_UNSUPPORTED_TEXT,
  copyStatusText,
  formatCommandBody,
  formatDuration,
  formatToolResult,
  humanizeTokens,
  metersFitAt,
  middleEllipsize,
  STATUS_METERS_MIN_WIDTH,
  splitThink,
  stripThink,
  turnMarker,
} from "../src/format"

// --- humanizeTokens ---

test("humanizeTokens prints small counts as plain integers, never a '0.0k'-style suffix", () => {
  expect(humanizeTokens(0)).toBe("0")
  expect(humanizeTokens(5)).toBe("5")
  expect(humanizeTokens(999)).toBe("999")
})

test("humanizeTokens abbreviates thousands with one decimal", () => {
  expect(humanizeTokens(2400)).toBe("2.4k")
  expect(humanizeTokens(124032)).toBe("124.0k")
  expect(humanizeTokens(1000)).toBe("1.0k")
})

// --- middleEllipsize ---

test("middleEllipsize leaves short text untouched", () => {
  expect(middleEllipsize("short", 20)).toBe("short")
})

test("middleEllipsize trims the middle, keeping the prefix and suffix identifiable", () => {
  const path = 'git commit -F "C:\\Users\\dev\\AppData\\Local\\Temp\\bfly\\COMMIT_EDITMSG"'
  const result = middleEllipsize(path, 30)
  expect(result.length).toBe(30)
  expect(result).toContain("…")
  expect(result.startsWith("git commit")).toBe(true)
  expect(result.endsWith('MSG"')).toBe(true)
})

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

// --- formatToolResult status words ---

test("formatToolResult prefixes plain 'ok'/'failed' words, never a check/cross glyph", () => {
  const ok = formatToolResult("all good", false)
  const failed = formatToolResult("broke", true)
  expect(ok.startsWith("ok ")).toBe(true)
  expect(failed.startsWith("failed ")).toBe(true)
  for (const text of [ok, failed]) {
    expect(text).not.toContain("✓")
    expect(text).not.toContain("✗")
  }
})

// --- splitThink ---

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

// --- formatCommandBody ---

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

// --- formatDuration / turnMarker ---

test("formatDuration prints seconds-only under a minute", () => {
  expect(formatDuration(0)).toBe("0s")
  expect(formatDuration(9_400)).toBe("9s")
  expect(formatDuration(59_000)).toBe("59s")
})

test("formatDuration prints minutes+seconds at/above a minute", () => {
  expect(formatDuration(72_000)).toBe("1m 12s")
  expect(formatDuration(60_000)).toBe("1m 0s")
  expect(formatDuration(59_600)).toBe("1m 0s") // rounds to 60s first, then splits
})

test("formatDuration clamps negative input instead of printing a negative duration", () => {
  expect(formatDuration(-500)).toBe("0s")
})

test("turnMarker appends the duration when given one", () => {
  const usage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 }
  expect(turnMarker(usage, 1, 83_000)).toBe("in 5 · out 3 · cached 0 · 1 steps · 1m 23s")
})

test("turnMarker omits the duration segment entirely when none is given — replay must never fabricate one", () => {
  const usage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0 }
  const marker = turnMarker(usage, 1)
  expect(marker).toBe("in 5 · out 3 · cached 0 · 1 steps")
  expect(marker).not.toMatch(/\d+s$/)
})

// --- metersFitAt ---

test("metersFitAt is a pinned cutoff at STATUS_METERS_MIN_WIDTH, not a soft/organic one", () => {
  expect(metersFitAt(STATUS_METERS_MIN_WIDTH - 1)).toBe(false)
  expect(metersFitAt(STATUS_METERS_MIN_WIDTH)).toBe(true)
  expect(metersFitAt(STATUS_METERS_MIN_WIDTH + 40)).toBe(true)
})

// --- copyStatusText ---

test("copyStatusText: plain 'copied' for a selection under the cap", () => {
  expect(copyStatusText(false)).toBe("copied")
})

test("copyStatusText: truncation notice names the cap and says what happened", () => {
  expect(copyStatusText(true)).toBe(`copied first ${osc52CapLabel()} (selection truncated)`)
})

test("copyStatusText: the truncation figure is the RAW size the clipboard got, derived from the one constant", () => {
  const notice = copyStatusText(true)
  // The cap is 100KB base64-side, but only floor(cap/4)*3 raw bytes are copied.
  expect(notice).toContain(`~${Math.round(OSC52_TEXT_CAP_BYTES / 1024)}KB`)
  expect(notice).not.toContain("100KB")
  // Derived from the constant, not hardcoded.
  expect(notice).toContain(osc52CapLabel())
})

test("COPY_UNSUPPORTED_TEXT: honest, plain, and never claims a copy happened", () => {
  expect(COPY_UNSUPPORTED_TEXT).toBe("clipboard copy not supported by this terminal")
  expect(COPY_UNSUPPORTED_TEXT).not.toContain("copied")
})
