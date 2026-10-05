import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FRECENCY_CAP,
  type FrecencyEntry,
  frecencyScore,
  frecencyStorePath,
  loadFrecency,
  rankByFrecency,
  touchFrecency,
  withFrecencyTouch,
} from "../src/context/frecency"
import type { ToolContext, ToolDefinition } from "../src/tool/registry"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const DAY = 86_400_000

test("frecencyScore matches the design formula: freq / (1 + ageDays)", () => {
  const now = 10 * DAY
  expect(frecencyScore({ path: "a.ts", freq: 4, lastOpen: now }, now)).toBe(4)
  expect(frecencyScore({ path: "a.ts", freq: 4, lastOpen: now - DAY }, now)).toBe(2)
  expect(frecencyScore({ path: "a.ts", freq: 4, lastOpen: now - 3 * DAY }, now)).toBe(1)
})

test("frecencyStorePath points at .butterfly/frecency.ndjson under cwd", () => {
  expect(frecencyStorePath("D:\\repo")).toBe(join("D:\\repo", ".butterfly", "frecency.ndjson"))
})

test("loadFrecency on a missing store returns an empty list, never throws", () => {
  const dir = tempDir("bfly-frecency-")
  expect(loadFrecency(join(dir, "nope.ndjson"))).toEqual([])
})

test("touchFrecency creates a new entry and persists it as NDJSON", () => {
  const store = join(tempDir("bfly-frecency-"), ".butterfly", "frecency.ndjson")
  const now = 5 * DAY
  const entries = touchFrecency(store, "src/app.ts", now)
  expect(entries).toEqual([{ path: "src/app.ts", freq: 1, lastOpen: now }])

  const reloaded = loadFrecency(store)
  expect(reloaded).toEqual([{ path: "src/app.ts", freq: 1, lastOpen: now }])

  const raw = readFileSync(store, "utf8")
  expect(raw.trim().split("\n")).toHaveLength(1)
  expect(JSON.parse(raw.trim())).toEqual({ path: "src/app.ts", freq: 1, lastOpen: now })
})

test("touchFrecency on an existing path increments freq and bumps lastOpen", () => {
  const store = join(tempDir("bfly-frecency-"), ".butterfly", "frecency.ndjson")
  touchFrecency(store, "src/app.ts", 1 * DAY)
  const after = touchFrecency(store, "src/app.ts", 2 * DAY)
  expect(after).toEqual([{ path: "src/app.ts", freq: 2, lastOpen: 2 * DAY }])
})

test("touchFrecency caps the store at 1000 entries, dropping the oldest lastOpen first (LRU)", () => {
  const dir = tempDir("bfly-frecency-")
  const store = join(dir, ".butterfly", "frecency.ndjson")

  // Seed FRECENCY_CAP entries directly (touching 1000 times would be slow).
  const seeded: FrecencyEntry[] = []
  for (let i = 0; i < FRECENCY_CAP; i++) {
    seeded.push({ path: `file-${i}.ts`, freq: 1, lastOpen: i })
  }
  mkdirSync(join(dir, ".butterfly"), { recursive: true })
  writeFileSync(store, `${seeded.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8")
  expect(loadFrecency(store)).toHaveLength(FRECENCY_CAP)

  // One more new path pushes the store over the cap and the LRU rewrite drops
  // only the oldest entry (file-0.ts, lastOpen=0).
  const after = touchFrecency(store, "new-file.ts", FRECENCY_CAP)
  expect(after).toHaveLength(FRECENCY_CAP)
  expect(after.some((e) => e.path === "file-0.ts")).toBe(false)
  expect(after.some((e) => e.path === "new-file.ts")).toBe(true)
  expect(after.some((e) => e.path === "file-1.ts")).toBe(true)
})

test("rankByFrecency sorts candidates by score descending", () => {
  const now = 10 * DAY
  const entries: FrecencyEntry[] = [
    { path: "cold.ts", freq: 1, lastOpen: now - 9 * DAY },
    { path: "hot.ts", freq: 5, lastOpen: now },
    { path: "warm.ts", freq: 2, lastOpen: now - DAY },
  ]
  const ranked = rankByFrecency(["cold.ts", "warm.ts", "hot.ts"], entries, now)
  expect(ranked).toEqual(["hot.ts", "warm.ts", "cold.ts"])
})

test("rankByFrecency puts never-touched candidates last, preserving their relative order", () => {
  const entries: FrecencyEntry[] = [{ path: "known.ts", freq: 3, lastOpen: 0 }]
  const ranked = rankByFrecency(["unknown-a.ts", "known.ts", "unknown-b.ts"], entries, 0)
  expect(ranked).toEqual(["known.ts", "unknown-a.ts", "unknown-b.ts"])
})

test("withFrecencyTouch bumps the store on a successful call, using ctx.cwd to relativize the path", async () => {
  const cwd = tempDir("bfly-frecency-cwd-")
  const store = join(cwd, ".butterfly", "frecency.ndjson")
  const input = { file_path: join(cwd, "src", "thing.ts") }
  const fakeTool: ToolDefinition<typeof input> = {
    name: "read",
    description: "fake",
    inputSchema: {
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    } as never,
    async execute() {
      return { output: "ok" }
    },
  }
  const wrapped = withFrecencyTouch(fakeTool, store, (i) => i.file_path)
  const ctx: ToolContext = { cwd, rules: {}, state: {} }
  await wrapped.execute(input, ctx)
  const entries = loadFrecency(store)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ path: "src/thing.ts", freq: 1 })
  expect(typeof entries[0]?.lastOpen).toBe("number")
})

test("withFrecencyTouch does not touch the store when the tool call errors", async () => {
  const cwd = tempDir("bfly-frecency-cwd-")
  const store = join(cwd, ".butterfly", "frecency.ndjson")
  const input = { file_path: "src/missing.ts" }
  const failingTool: ToolDefinition<typeof input> = {
    name: "read",
    description: "fake",
    inputSchema: {
      parse: (v: unknown) => v,
      safeParse: (v: unknown) => ({ success: true, data: v }),
    } as never,
    async execute() {
      return { output: "nope", isError: true }
    },
  }
  const wrapped = withFrecencyTouch(failingTool, store, (i) => i.file_path)
  const ctx: ToolContext = { cwd, rules: {}, state: {} }
  await wrapped.execute(input, ctx)
  expect(loadFrecency(store)).toEqual([])
})
