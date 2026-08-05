import { describe, expect, test } from "bun:test"
import {
  addPasteChip,
  chipLabel,
  endsWithChip,
  expandChips,
  expandComposerText,
  insertedSpan,
  lineCount,
  NEWLINE_MARKER,
  PASTE_CHIP_CHAR_THRESHOLD,
  PASTE_CHIP_LINE_THRESHOLD,
  PASTE_RATE_HEURISTIC_CHARS,
  removeTrailingChip,
  shouldChip,
  toComposerDraft,
  unreferencedChips,
} from "../src/paste"

describe("shouldChip", () => {
  test("text at or under the char threshold and at or under the line threshold is NOT chipped", () => {
    expect(shouldChip("a".repeat(PASTE_CHIP_CHAR_THRESHOLD))).toBe(false)
    expect(shouldChip("a\nb")).toBe(false) // 2 lines
  })

  test("text over the char threshold IS chipped", () => {
    expect(shouldChip("a".repeat(PASTE_CHIP_CHAR_THRESHOLD + 1))).toBe(true)
  })

  test("text with more than 2 lines IS chipped, even if short", () => {
    expect(shouldChip("a\nb\nc")).toBe(true) // 3 lines
  })

  test("text with exactly 2 lines is NOT chipped by the line rule alone", () => {
    expect(shouldChip("a\nb")).toBe(false)
  })

  test("a single short line is never chipped", () => {
    expect(shouldChip("hello")).toBe(false)
  })
})

describe("lineCount", () => {
  test("counts newline-separated segments", () => {
    expect(lineCount("a")).toBe(1)
    expect(lineCount("a\nb")).toBe(2)
    expect(lineCount("a\nb\nc")).toBe(3)
  })
})

describe("chipLabel", () => {
  test("matches the label format", () => {
    expect(chipLabel(1, 120)).toBe("[Pasted #1 +120 lines]")
    expect(chipLabel(2, 5)).toBe("[Pasted #2 +5 lines]")
  })
})

describe("addPasteChip", () => {
  test("appends the label to the draft and stores the payload under the given number", () => {
    const result = addPasteChip("look at ", "a\nb\nc", new Map(), 1)
    expect(result.draftWithChip).toBe("look at [Pasted #1 +3 lines]")
    expect(result.payloads.get(1)).toBe("a\nb\nc")
    expect(result.nextChipNumber).toBe(2)
  })

  test("a second chip gets the next number and both payloads survive", () => {
    const first = addPasteChip("", "x".repeat(900), new Map(), 1)
    const second = addPasteChip(
      first.draftWithChip,
      "y".repeat(900),
      first.payloads,
      first.nextChipNumber,
    )
    expect(second.draftWithChip).toBe(`[Pasted #1 +1 lines][Pasted #2 +1 lines]`)
    expect(second.payloads.get(1)).toBe("x".repeat(900))
    expect(second.payloads.get(2)).toBe("y".repeat(900))
    expect(second.nextChipNumber).toBe(3)
  })

  test("does not mutate the payloads map passed in (immutable update)", () => {
    const original = new Map<number, string>()
    addPasteChip("", "big paste", original, 1)
    expect(original.size).toBe(0)
  })
})

describe("endsWithChip", () => {
  test("detects a chip at the very end of the string", () => {
    const result = endsWithChip("look at [Pasted #3 +42 lines]")
    expect(result).toEqual({ label: "[Pasted #3 +42 lines]", n: 3 })
  })

  test("returns null when the string does not end with a chip", () => {
    expect(endsWithChip("look at [Pasted #3 +42 lines] more text")).toBeNull()
    expect(endsWithChip("plain text")).toBeNull()
    expect(endsWithChip("")).toBeNull()
  })

  test("returns null for a partially-typed/broken chip-looking string", () => {
    expect(endsWithChip("[Pasted #3 +42 lines")).toBeNull()
    expect(endsWithChip("Pasted #3 +42 lines]")).toBeNull()
  })
})

describe("expandChips", () => {
  test("replaces a single chip reference with its payload", () => {
    const payloads = new Map([[1, "the real long pasted content"]])
    expect(expandChips("before [Pasted #1 +3 lines] after", payloads)).toBe(
      "before the real long pasted content after",
    )
  })

  test("expands multiple chips in order", () => {
    const payloads = new Map([
      [1, "FIRST"],
      [2, "SECOND"],
    ])
    expect(expandChips("[Pasted #1 +1 lines] and [Pasted #2 +1 lines]", payloads)).toBe(
      "FIRST and SECOND",
    )
  })

  test("a reference with no matching payload is left as literal text (defensive — never drop text)", () => {
    const payloads = new Map<number, string>()
    expect(expandChips("stale [Pasted #9 +1 lines] ref", payloads)).toBe(
      "stale [Pasted #9 +1 lines] ref",
    )
  })

  test("text with no chips at all passes through unchanged", () => {
    expect(expandChips("just plain text", new Map())).toBe("just plain text")
  })
})

describe("expandComposerText", () => {
  test("expands chips AND turns newline markers back into real newlines", () => {
    const payloads = new Map([[1, "pasted\nmultiline\ncontent"]])
    const composer = `line one${NEWLINE_MARKER}[Pasted #1 +3 lines]${NEWLINE_MARKER}line three`
    expect(expandComposerText(composer, payloads)).toBe(
      "line one\npasted\nmultiline\ncontent\nline three",
    )
  })

  test("with no chips or markers, returns the text unchanged", () => {
    expect(expandComposerText("plain text", new Map())).toBe("plain text")
  })
})

describe("insertedSpan", () => {
  test("a paste appended at the end is the whole appended span", () => {
    expect(insertedSpan("hello ", "hello world")).toBe("world")
  })

  test("a paste inserted at the start is detected", () => {
    expect(insertedSpan("world", "hello world")).toBe("hello ")
  })

  test("a paste inserted in the middle is detected via prefix+suffix trim", () => {
    expect(insertedSpan("ac", "abc")).toBe("b")
  })

  test("no growth (same length, or a deletion) returns empty", () => {
    expect(insertedSpan("abc", "abc")).toBe("")
    expect(insertedSpan("abc", "ab")).toBe("")
    expect(insertedSpan("abc", "xyz")).toBe("")
  })

  test("growing from empty returns the whole new value", () => {
    expect(insertedSpan("", "pasted")).toBe("pasted")
  })
})

describe("PASTE_RATE_HEURISTIC_CHARS", () => {
  test("is comfortably above plausible fast-typing speed", () => {
    // 200 wpm (very fast) ≈ 17 chars/sec ≈ 0.3 chars per 16ms frame.
    expect(PASTE_RATE_HEURISTIC_CHARS).toBeGreaterThan(50)
    expect(PASTE_RATE_HEURISTIC_CHARS).toBeLessThan(PASTE_CHIP_CHAR_THRESHOLD)
  })
})

describe("PASTE_CHIP_LINE_THRESHOLD", () => {
  test("chips pastes of more than 2 lines", () => {
    expect(PASTE_CHIP_LINE_THRESHOLD).toBe(2)
  })
})

describe("toComposerDraft", () => {
  test("turns real newlines into the marker the single-line composer can hold", () => {
    expect(toComposerDraft("a\nb\nc")).toBe(`a${NEWLINE_MARKER}b${NEWLINE_MARKER}c`)
  })

  test("carriage returns collapse into a single marker, never a stray \\r", () => {
    expect(toComposerDraft("a\r\nb")).toBe(`a${NEWLINE_MARKER}b`)
  })

  test("text without newlines is untouched", () => {
    expect(toComposerDraft("plain")).toBe("plain")
  })

  test("round-trips through expandComposerText (the exact history-recall path)", () => {
    const stored = "line one\nline two\nline three"
    expect(expandComposerText(toComposerDraft(stored), new Map())).toBe(stored)
  })
})

describe("removeTrailingChip", () => {
  test("removes the whole trailing label and drops its payload", () => {
    const payloads = new Map([[1, "PAYLOAD"]])
    const result = removeTrailingChip("look at [Pasted #1 +1 lines]", payloads)
    expect(result).not.toBeNull()
    expect(result?.draft).toBe("look at ")
    expect(result?.payloads.has(1)).toBe(false)
  })

  test("returns null when the draft does not end with a chip", () => {
    expect(removeTrailingChip("plain text", new Map())).toBeNull()
  })

  test("KEEPS the payload when an identical label still remains in the draft", () => {
    const payloads = new Map([[1, "PAYLOAD"]])
    const result = removeTrailingChip("[Pasted #1 +1 lines] [Pasted #1 +1 lines]", payloads)
    expect(result?.draft).toBe("[Pasted #1 +1 lines] ")
    expect(result?.payloads.get(1)).toBe("PAYLOAD")
  })

  test("does not mutate the map passed in", () => {
    const payloads = new Map([[1, "PAYLOAD"]])
    removeTrailingChip("[Pasted #1 +1 lines]", payloads)
    expect(payloads.get(1)).toBe("PAYLOAD")
  })
})

describe("unreferencedChips", () => {
  test("no orphans when every payload still has a label in the text", () => {
    const payloads = new Map([
      [1, "A"],
      [2, "B"],
    ])
    expect(unreferencedChips("[Pasted #1 +1 lines] x [Pasted #2 +1 lines]", payloads)).toEqual([])
  })

  test("a label edited into a no-longer-matching shape orphans its payload", () => {
    const payloads = new Map([[1, "A"]])
    expect(unreferencedChips("[Pasted #1 +1 lines", payloads)).toEqual([1])
  })

  test("a payload whose label was removed entirely is reported", () => {
    const payloads = new Map([
      [1, "A"],
      [2, "B"],
    ])
    expect(unreferencedChips("only [Pasted #2 +1 lines] left", payloads)).toEqual([1])
  })

  test("orphans come back in ascending chip order", () => {
    const payloads = new Map([
      [2, "B"],
      [1, "A"],
    ])
    expect(unreferencedChips("nothing here", payloads)).toEqual([1, 2])
  })

  test("an empty payload map never reports anything", () => {
    expect(unreferencedChips("[Pasted #7 +1 lines]", new Map())).toEqual([])
  })
})
