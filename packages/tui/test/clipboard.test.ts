import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  capOsc52Text,
  OSC52_BASE64_CAP,
  OSC52_TEXT_CAP_BYTES,
  osc52CapLabel,
  saveClipboardImage,
} from "../src/clipboard"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("returns the saved path when the stubbed PowerShell process exits 0 and writes the file", async () => {
  const cwd = tempDir("bfly-clip-")
  const path = await saveClipboardImage(cwd, {
    now: () => 12345,
    spawn: (cmd) => {
      expect(cmd[0]).toBe("powershell.exe")
      expect(cmd.join(" ")).toContain("Get-Clipboard")
      // Simulate PowerShell itself having saved the clipboard image.
      writeFileSync(join(cwd, ".butterfly", "media", "12345.png"), Buffer.from("fake-png"))
      return { exited: Promise.resolve(0), kill: () => {} }
    },
  })
  expect(path).toBe(join(cwd, ".butterfly", "media", "12345.png"))
  expect(existsSync(path ?? "")).toBe(true)
})

test("returns null (fail-soft) when the clipboard has no image — non-zero exit", async () => {
  const cwd = tempDir("bfly-clip-")
  const path = await saveClipboardImage(cwd, {
    spawn: () => ({ exited: Promise.resolve(1), kill: () => {} }),
  })
  expect(path).toBeNull()
})

test("returns null when the process exits 0 but never actually wrote the file", async () => {
  const cwd = tempDir("bfly-clip-")
  const path = await saveClipboardImage(cwd, {
    spawn: () => ({ exited: Promise.resolve(0), kill: () => {} }),
  })
  expect(path).toBeNull()
})

test("returns null (fail-soft) when spawn itself throws — e.g. powershell.exe missing", async () => {
  const cwd = tempDir("bfly-clip-")
  const path = await saveClipboardImage(cwd, {
    spawn: () => {
      throw new Error("ENOENT")
    },
  })
  expect(path).toBeNull()
})


function base64Len(text: string): number {
  return Buffer.from(text, "utf-8").toString("base64").length
}

test("capOsc52Text: text under the cap passes through byte-identical, untruncated", () => {
  const { text, truncated } = capOsc52Text("hello world")
  expect(text).toBe("hello world")
  expect(truncated).toBe(false)
})

test("capOsc52Text: empty string is a valid, untruncated payload", () => {
  expect(capOsc52Text("")).toEqual({ text: "", truncated: false })
})

test("capOsc52Text: a payload exactly at the cap is NOT truncated and lands exactly on it", () => {
  const text = "a".repeat(OSC52_TEXT_CAP_BYTES)
  const capped = capOsc52Text(text)
  expect(capped.truncated).toBe(false)
  expect(capped.text).toBe(text)
  expect(base64Len(capped.text)).toBe(OSC52_BASE64_CAP)
})

test("capOsc52Text: a payload over the cap is truncated to a strict prefix that still fits", () => {
  const text = "x".repeat(OSC52_BASE64_CAP * 2) // way over — guarantees truncation
  const { text: capped, truncated } = capOsc52Text(text)
  expect(truncated).toBe(true)
  expect(capped.length).toBeGreaterThan(0)
  expect(capped.length).toBeLessThan(text.length)
  expect(text.startsWith(capped)).toBe(true)
  expect(base64Len(capped)).toBeLessThanOrEqual(OSC52_BASE64_CAP)
})

test("capOsc52Text: respects a custom cap (not hardcoded to the default)", () => {
  const { text, truncated } = capOsc52Text("hello world", 8)
  expect(truncated).toBe(true)
  expect(base64Len(text)).toBeLessThanOrEqual(8)
})

const CJK_A = String.fromCodePoint(0x4e16)
const CJK_B = String.fromCodePoint(0x754c)
/** U+FFFD - what a decoder emits when a UTF-8 sequence was cut in half. */
const REPLACEMENT = String.fromCodePoint(0xfffd)

test("capOsc52Text: a multi-byte character straddling the cut is dropped whole, never split", () => {
  const text = `ab${CJK_A}${CJK_B}`
  expect(Buffer.from(text, "utf-8").length).toBe(8)
  const { text: capped, truncated } = capOsc52Text(text, 8)
  expect(truncated).toBe(true)
  expect(capped).toBe(`ab${CJK_A}`)
  expect(Buffer.from(capped, "utf-8").length).toBe(5)
  expect(capped).not.toContain(REPLACEMENT)
  expect(text.startsWith(capped)).toBe(true)
})

test("capOsc52Text: a multi-byte payload trimmed at the REAL cap still ends cleanly", () => {
  const text = `a${CJK_A.repeat(OSC52_BASE64_CAP)}`
  const { text: capped, truncated } = capOsc52Text(text)
  expect(truncated).toBe(true)
  expect(capped).not.toContain(REPLACEMENT)
  expect(text.startsWith(capped)).toBe(true)
  expect(base64Len(capped)).toBeLessThanOrEqual(OSC52_BASE64_CAP)
  expect(Buffer.from(capped, "utf-8").length).toBeLessThan(OSC52_TEXT_CAP_BYTES)
})

test("the user-facing cap figure is DERIVED from the one constant, not typed twice", () => {
  expect(OSC52_TEXT_CAP_BYTES).toBe(Math.floor(OSC52_BASE64_CAP / 4) * 3)
  expect(osc52CapLabel()).toBe(`~${Math.round(OSC52_TEXT_CAP_BYTES / 1024)}KB`)
  expect(osc52CapLabel()).not.toContain("100")
})

