import { expect, test } from "bun:test"
import { renderWordmark, WORDMARK_ROWS, wordmarkMode } from "../src/wordmark"

test("both words render 6 equal-width rows of ANSI-shadow glyphs", () => {
  const mark = renderWordmark()
  for (const rows of [mark.left, mark.right]) {
    expect(rows.length).toBe(WORDMARK_ROWS)
    const widths = new Set(rows.map((row) => row.length))
    expect(widths.size).toBe(1)
    for (const row of rows) expect(row).toMatch(/^[█╗╔═║╝╚ ]+$/)
  }
})

test("responsive modes: single on wide, stacked on medium, plain on narrow", () => {
  const mark = renderWordmark()
  expect(wordmarkMode(mark.singleWidth + 10)).toBe("single")
  expect(wordmarkMode(mark.stackedWidth + 6)).toBe("stacked")
  expect(wordmarkMode(60)).toBe("plain")
  expect(mark.singleWidth).toBeGreaterThan(mark.stackedWidth)
})
