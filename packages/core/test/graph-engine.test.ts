import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { estimateTokens } from "../src/context/tokens"
import { GraphDb } from "../src/graph/db"
import { createExploreTool } from "../src/graph/explore-tool"
import { rankedDefinitions, rankFiles } from "../src/graph/rank"
import { disposeScanners, type Tag } from "../src/graph/scan"
import { buildSkeleton } from "../src/graph/skeleton"
import { syncRepo } from "../src/graph/sync"
import type { ToolContext } from "../src/tool/registry"

afterAll(() => {
  disposeScanners()
})

function tag(partial: Partial<Tag> & Pick<Tag, "kind" | "name">): Tag {
  return { symbolKind: partial.kind === "def" ? "function" : "call", row: 0, endRow: 0, ...partial }
}

function seededDb(): GraphDb {
  const db = GraphDb.open(":memory:")
  // core.ts defines heavily-used util(); extra.ts defines rarely-used rare().
  db.upsertFile("src/core.ts", "h1", [
    tag({ kind: "def", name: "util", row: 2, endRow: 8 }),
    tag({ kind: "def", name: "internal_helper", row: 10, endRow: 12 }),
  ])
  db.upsertFile("src/extra.ts", "h2", [
    tag({ kind: "def", name: "rare", row: 1, endRow: 3 }),
    tag({ kind: "ref", name: "util" }),
    tag({ kind: "ref", name: "util" }),
  ])
  db.upsertFile("src/app.ts", "h3", [
    tag({ kind: "ref", name: "util" }),
    tag({ kind: "ref", name: "util" }),
    tag({ kind: "ref", name: "util" }),
  ])
  return db
}

// --- GraphDb ---

test("upsert replaces a file's tags and hashes are queryable", () => {
  const db = GraphDb.open(":memory:")
  db.upsertFile("a.ts", "hash1", [tag({ kind: "def", name: "one" })])
  db.upsertFile("a.ts", "hash2", [tag({ kind: "def", name: "two" })])
  expect(db.fileHash("a.ts")).toBe("hash2")
  expect(db.defs().map((d) => d.name)).toEqual(["two"])
  db.removeFile("a.ts")
  expect(db.defs().length).toBe(0)
  expect(db.fileHash("a.ts")).toBeUndefined()
  db.close()
})

test("refs aggregate counts per file+name", () => {
  const db = GraphDb.open(":memory:")
  db.upsertFile("b.ts", "h", [
    tag({ kind: "ref", name: "util" }),
    tag({ kind: "ref", name: "util" }),
  ])
  expect(db.refs()).toEqual([{ file: "b.ts", name: "util", count: 2 }])
  db.close()
})

// --- rank ---

test("files defining heavily-referenced symbols rank highest", () => {
  const db = seededDb()
  const ranks = rankFiles(db)
  const core = ranks.get("src/core.ts") ?? 0
  const extra = ranks.get("src/extra.ts") ?? 0
  expect(core).toBeGreaterThan(extra)
  db.close()
})

test("ranked definitions put the popular symbol first and private helpers low", () => {
  const db = seededDb()
  const names = rankedDefinitions(db).map((d) => d.name)
  expect(names[0]).toBe("util")
  expect(names.indexOf("internal_helper")).toBeGreaterThan(names.indexOf("util"))
  db.close()
})

test("mentioned identifiers boost their definitions", () => {
  const db = seededDb()
  const names = rankedDefinitions(db, { mentionedIdents: ["rare"] }).map((d) => d.name)
  expect(names.indexOf("rare")).toBeLessThan(names.indexOf("internal_helper"))
  db.close()
})

// --- skeleton ---

test("skeleton stays within budget and keeps the top symbol", () => {
  const db = seededDb()
  const skeleton = buildSkeleton(db, { budgetTokens: 60 })
  expect(skeleton).toContain("util")
  expect(skeleton).toContain("src/core.ts")
  expect(estimateTokens(skeleton)).toBeLessThanOrEqual(60)
  db.close()
})

test("empty graph yields an empty skeleton", () => {
  const db = GraphDb.open(":memory:")
  expect(buildSkeleton(db)).toBe("")
  db.close()
})

// --- sync ---

test("sync scans, skips unchanged, rescans edits, and drops deletions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-graph-"))
  mkdirSync(join(cwd, "src"), { recursive: true })
  writeFileSync(join(cwd, "src", "a.ts"), "export function alpha() { return 1 }\n")
  writeFileSync(join(cwd, "src", "b.ts"), "export function beta() { return alpha() }\n")
  mkdirSync(join(cwd, "node_modules", "junk"), { recursive: true })
  writeFileSync(join(cwd, "node_modules", "junk", "x.ts"), "export function noise() {}\n")

  const db = GraphDb.open(":memory:")
  const first = await syncRepo(cwd, db)
  expect(first.scanned).toBe(2)

  const second = await syncRepo(cwd, db)
  expect(second).toEqual({ scanned: 0, skipped: 2, removed: 0 })

  writeFileSync(join(cwd, "src", "a.ts"), "export function alpha2() { return 2 }\n")
  rmSync(join(cwd, "src", "b.ts"))
  const third = await syncRepo(cwd, db)
  expect(third.scanned).toBe(1)
  expect(third.removed).toBe(1)
  expect(db.defs().map((d) => d.name)).toEqual(["alpha2"])
  db.close()
})

// --- explore tool ---

test("explore returns the symbol body and its callers in one call", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "bfly-explore-"))
  mkdirSync(join(cwd, "src"), { recursive: true })
  writeFileSync(
    join(cwd, "src", "util.ts"),
    "export function shine(n: number): number {\n  return n * 2\n}\n",
  )
  writeFileSync(join(cwd, "src", "app.ts"), "const x = shine(21)\n")

  const db = GraphDb.open(":memory:")
  await syncRepo(cwd, db)

  const tool = createExploreTool({ db: () => db, cwd })
  const ctx: ToolContext = { cwd, rules: { "*": "allow" }, state: {} }
  const result = await tool.execute({ query: "shine" }, ctx)

  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("return n * 2")
  expect(result.output).toContain("src/util.ts")
  expect(result.output).toContain("app.ts")
  db.close()
})

test("explore with no match suggests grep", async () => {
  const db = GraphDb.open(":memory:")
  const tool = createExploreTool({ db: () => db, cwd: "/w" })
  const ctx: ToolContext = { cwd: "/w", rules: { "*": "allow" }, state: {} }
  const result = await tool.execute({ query: "nothing_here" }, ctx)
  expect(result.output.toLowerCase()).toContain("grep")
  db.close()
})
