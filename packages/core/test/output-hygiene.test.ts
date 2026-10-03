import { expect, test } from "bun:test"
import {
  cleanCommandOutput,
  collapseRepeats,
  resolveCarriageReturns,
  stripAnsi,
} from "../src/tool/output-hygiene"

test("strips SGR colors, cursor moves and OSC hyperlinks", () => {
  expect(stripAnsi("\x1b[31mFAIL\x1b[0m src/a.test.ts")).toBe("FAIL src/a.test.ts")
  expect(stripAnsi("\x1b[2K\x1b[1Gdone")).toBe("done")
  expect(stripAnsi("\x1b]8;;https://x.dev\x07link\x1b]8;;\x07")).toBe("link")
  expect(stripAnsi("plain")).toBe("plain")
})

test("carriage-return progress frames resolve to the final frame", () => {
  expect(resolveCarriageReturns("Downloading 10%\rDownloading 55%\rDownloading 100%\nok")).toBe(
    "Downloading 100%\nok",
  )
  // CRLF is a line ending, not an overwrite.
  expect(resolveCarriageReturns("a\r\nb\r\n")).toBe("a\nb\n")
})

test("runs of identical lines collapse; short runs and blank lines are kept", () => {
  const noisy = ["start", ...Array(40).fill("warn: deprecated API"), "end"].join("\n")
  expect(collapseRepeats(noisy)).toBe(
    "start\nwarn: deprecated API\n[... previous line repeated 39 more times]\nend",
  )
  expect(collapseRepeats("x\nx\ny")).toBe("x\nx\ny")
  expect(collapseRepeats("a\n\n\n\nb")).toBe("a\n\n\n\nb")
})

test("cleanCommandOutput composes all three", () => {
  const raw = `\x1b[32m✓\x1b[0m one\r\n${"\x1b[33mretry\x1b[0m\n".repeat(5)}50%\r100%\n`
  expect(cleanCommandOutput(raw)).toBe(
    "✓ one\nretry\n[... previous line repeated 4 more times]\n100%\n",
  )
})
