import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildOsc52Copy, OSC52_BASE64_CAP, saveClipboardImage } from "../src/clipboard"

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


test("buildOsc52Copy: wraps the base64 payload in the exact OSC 52 sequence and round-trips", () => {
  const { osc, truncated } = buildOsc52Copy("hello world")
  const expectedB64 = Buffer.from("hello world", "utf-8").toString("base64")
  expect(osc).toBe(`\x1b]52;c;${expectedB64}\x07`)
  expect(truncated).toBe(false)
  const match = osc.match(/^\x1b\]52;c;(.*)\x07$/)
  expect(match).not.toBeNull()
  expect(Buffer.from(match?.[1] ?? "", "base64").toString("utf-8")).toBe("hello world")
})

test("buildOsc52Copy: empty string still produces a valid (empty-payload) sequence", () => {
  const { osc, truncated } = buildOsc52Copy("")
  expect(osc).toBe("\x1b]52;c;\x07")
  expect(truncated).toBe(false)
})

test("buildOsc52Copy: a payload exactly at the cap is NOT truncated", () => {
  const byteLen = (OSC52_BASE64_CAP / 4) * 3
  const text = "a".repeat(byteLen)
  const { osc, truncated } = buildOsc52Copy(text)
  expect(truncated).toBe(false)
  const b64 = osc.slice("\x1b]52;c;".length, -1)
  expect(b64.length).toBe(OSC52_BASE64_CAP)
})

test("buildOsc52Copy: a payload over the cap is truncated, notice-worthy, and still valid base64", () => {
  const text = "x".repeat(OSC52_BASE64_CAP * 2) // way over — guarantees truncation
  const { osc, truncated } = buildOsc52Copy(text)
  expect(truncated).toBe(true)
  const match = osc.match(/^\x1b\]52;c;(.*)\x07$/)
  expect(match).not.toBeNull()
  const b64 = match?.[1] ?? ""
  expect(b64.length).toBeLessThanOrEqual(OSC52_BASE64_CAP)
  const decoded = Buffer.from(b64, "base64").toString("utf-8")
  expect(decoded.length).toBeGreaterThan(0)
  expect(decoded.length).toBeLessThan(text.length)
  expect(text.startsWith(decoded.replace(/�/g, "x"))).toBe(true)
})

test("buildOsc52Copy: respects a custom cap (not hardcoded to the default)", () => {
  const { osc, truncated } = buildOsc52Copy("hello world", 4)
  expect(truncated).toBe(true)
  const b64 = osc.slice("\x1b]52;c;".length, -1)
  expect(b64.length).toBeLessThanOrEqual(4)
})

