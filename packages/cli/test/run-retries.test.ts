import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run"

/**
 * Headless `retries` wiring end to end: a real `runHeadless`, a real config
 * file and a local OpenAI-compatible endpoint that always fails, counting the
 * requests that reach the wire.
 *
 * The endpoint answers 503 + `Retry-After: 0` (retryable, zero backoff), so
 * retries run instantly. The counts also pin that the AI SDK's own
 * `maxRetries` isn't stacked under ours (they'd be 3x higher).
 */

function failingProviderFixture(): { port: number; hits: () => number; stop: () => void } {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      hits += 1
      return Response.json(
        { error: { message: "upstream overloaded", type: "server_error" } },
        { status: 503, headers: { "Retry-After": "0" } },
      )
    },
  })
  return { port: server.port ?? 0, hits: () => hits, stop: () => server.stop(true) }
}

function headlessCwd(retries: number, port: number): string {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-cli-retries-"))
  // Its own .git so the runner's snapshot walk stops here instead of
  // staging an ancestor repo.
  Bun.spawnSync(["git", "init", "-q"], { cwd, stdout: "ignore", stderr: "ignore" })
  writeFileSync(
    join(cwd, "butterfly.jsonc"),
    JSON.stringify({
      model: "fake/mock-error",
      providers: { fake: { baseURL: `http://127.0.0.1:${port}/v1` } },
      notifications: false,
      retries,
    }),
  )
  return cwd
}

test("headless honours `retries: 0` from butterfly.jsonc — exactly one provider request, no retry", async () => {
  const fixture = failingProviderFixture()
  try {
    const code = await runHeadless({ task: "hi", cwd: headlessCwd(0, fixture.port), json: true })
    expect(code).toBe(1)
    expect(fixture.hits()).toBe(1)
  } finally {
    fixture.stop()
  }
}, 60_000)

test("headless honours `retries: 2` from butterfly.jsonc — the initial attempt plus exactly two retries", async () => {
  const fixture = failingProviderFixture()
  try {
    const code = await runHeadless({ task: "hi", cwd: headlessCwd(2, fixture.port), json: true })
    expect(code).toBe(1)
    // 1 initial + 2 retries. The runner's default is 3, so this number can
    // only come from the config value having reached RunnerDeps.
    expect(fixture.hits()).toBe(3)
  } finally {
    fixture.stop()
  }
}, 60_000)
