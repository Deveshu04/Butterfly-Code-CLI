import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

declare global {
  // biome-ignore lint/suspicious/noRedeclare: global registry shared with test helpers
  var __bflyTestCleanup: Set<string> | undefined
}

const STALE_MS = 2 * 60 * 60 * 1000

if (!globalThis.__bflyTestCleanup) {
  const realTmp = tmpdir()
  const base = join(realTmp, "butterfly-tests")
  mkdirSync(base, { recursive: true })

  // Sweep runs that never got to clean up (crash, kill -9, CI timeout).
  try {
    for (const entry of readdirSync(base)) {
      const path = join(base, entry)
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) {
          rmSync(path, { recursive: true, force: true, maxRetries: 2 })
        }
      } catch {
        // in use by a concurrent run, or already gone
      }
    }
  } catch {
    // base unreadable — nothing to sweep
  }

  const run = mkdtempSync(join(base, "run-"))
  process.env["TMPDIR"] = run
  process.env["TEMP"] = run
  process.env["TMP"] = run
  process.env["BUTTERFLY_TEST_SANDBOX"] = run

  const cleanup = new Set<string>([run])
  globalThis.__bflyTestCleanup = cleanup
  afterAll(() => {
    for (const path of cleanup) {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch {
        // Windows file locks: the next run's stale sweep removes it
      }
    }
  })
}
