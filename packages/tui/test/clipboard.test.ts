import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveClipboardImage } from "../src/clipboard"

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

