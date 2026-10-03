import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodeGraph } from "../src/graph/code-graph"
import { GraphDb } from "../src/graph/db"
import { createExploreTool } from "../src/graph/explore-tool"
import { moduleOverview, renderProjectMap } from "../src/graph/project-map"
import { disposeScanners } from "../src/graph/scan"
import { focusedSkeleton } from "../src/graph/skeleton"
import { listSourceFiles, syncRepo } from "../src/graph/sync"
import type { ToolContext } from "../src/tool/registry"

afterAll(() => disposeScanners())

function write(root: string, rel: string, text: string): void {
  const path = join(root, rel)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

/** A tiny two-module repo: src/core defines, src/app consumes, test/ exercises. */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "bfly-codegraph-"))
  write(
    root,
    "src/core/store.ts",
    "export function createStore(name: string) {\n  return { name }\n}\n\nexport class SessionStore {\n  load() {\n    return createStore('x')\n  }\n}\n",
  )
  write(
    root,
    "src/app/main.ts",
    "import { createStore, SessionStore } from '../core/store'\n\nexport function bootApplication() {\n  const s = new SessionStore()\n  return createStore('main') && s\n}\n",
  )
  write(
    root,
    "test/store.test.ts",
    "import { createStore } from '../src/core/store'\nexport function makeFixtureStore() { return createStore('t') }\n",
  )
  return root
}

const ctx = {} as ToolContext

test("sync writes .butterfly/project-map.md with modules, a Mermaid graph, and central files", async () => {
  const root = fixtureRepo()
  const graph = CodeGraph.open(root)
  await graph.sync()
  expect(graph.ready).toBe(true)
  expect(existsSync(graph.mapPath)).toBe(true)
  const map = readFileSync(graph.mapPath, "utf8")
  expect(map).toContain("# Project map")
  expect(map).toContain("| `src/app` |")
  expect(map).toContain("```mermaid")
  expect(map).toContain("-->")
  expect(map).toContain("createStore")
  graph.close()
})

test("re-sync is a stat fast path; an edit is picked up and the map rewritten", async () => {
  const root = fixtureRepo()
  const graph = CodeGraph.open(root)
  const first = await graph.sync()
  expect(first.scanned).toBe(3)
  // Age the files past the racy-clean window so the fast path applies.
  const old = new Date(Date.now() - 60_000)
  for (const rel of ["src/core/store.ts", "src/app/main.ts", "test/store.test.ts"])
    utimesSync(join(root, rel), old, old)
  await graph.sync()
  const quiet = await graph.sync()
  expect(quiet).toEqual({ scanned: 0, skipped: 3, removed: 0 })

  write(root, "src/app/main.ts", "export function renamedBoot() {\n  return 1\n}\n")
  const changed = await graph.sync()
  expect(changed.scanned).toBe(1)
  expect(graph.db.lookupDefs("renamedBoot").length).toBe(1)
  expect(graph.db.lookupDefs("bootApplication").length).toBe(0)
  expect(readFileSync(graph.mapPath, "utf8")).toContain("renamedBoot")
  graph.close()
})

test("concurrent sync() calls share one run", async () => {
  const root = fixtureRepo()
  const graph = CodeGraph.open(root)
  const [a, b] = [graph.sync(), graph.sync()]
  expect(a).toBe(b)
  await a
  graph.close()
})

test("explore refresh sees an edit made after the last sync", async () => {
  const root = fixtureRepo()
  const graph = CodeGraph.open(root)
  await graph.sync()
  const tool = createExploreTool({
    db: () => graph.db,
    cwd: root,
    refresh: () => graph.fresh(0),
  })
  write(root, "src/core/extra.ts", "export function freshlyAddedHelper() { return 2 }\n")
  const out = await tool.execute({ query: "freshlyAddedHelper" }, ctx)
  expect(out.output).toContain("src/core/extra.ts:1")
  graph.close()
})

test("file dependency edges ignore test-file definers and generic names", async () => {
  const root = fixtureRepo()
  const db = GraphDb.open(":memory:")
  await syncRepo(root, db)
  const edges = db.fileEdges()
  expect(edges.some((e) => e.from === "src/app/main.ts" && e.to === "src/core/store.ts")).toBe(true)
  expect(edges.some((e) => e.to.startsWith("test/"))).toBe(false)
})

test("explore op=outline lists symbols with line ranges plus imports and users", async () => {
  const root = fixtureRepo()
  const db = GraphDb.open(":memory:")
  await syncRepo(root, db)
  const tool = createExploreTool({ db: () => db, cwd: root })
  const out = (await tool.execute({ op: "outline", query: "core/store.ts" }, ctx)).output
  expect(out).toContain("src/core/store.ts")
  expect(out).toMatch(/function createStore\s+:1-3/)
  expect(out).toContain("used by: src/app/main.ts")
  // A path typed into the default (symbol) op is answered as an outline.
  const slip = (await tool.execute({ query: "src/core/store.ts" }, ctx)).output
  expect(slip).toContain("createStore")
})

test("explore op=deps reports a file's blast radius and a symbol's users", async () => {
  const root = fixtureRepo()
  const db = GraphDb.open(":memory:")
  await syncRepo(root, db)
  const tool = createExploreTool({ db: () => db, cwd: root })
  const file = (await tool.execute({ op: "deps", query: "src/core/store.ts" }, ctx)).output
  expect(file).toContain("depended on by: src/app/main.ts")
  expect(file).toContain("blast radius")
  const symbol = (await tool.execute({ op: "deps", query: "createStore" }, ctx)).output
  expect(symbol).toContain("used by 2 file(s)")
})

test("explore op=map gives a module overview; non-map ops require a query", async () => {
  const root = fixtureRepo()
  const db = GraphDb.open(":memory:")
  await syncRepo(root, db)
  const tool = createExploreTool({ db: () => db, cwd: root })
  const map = (await tool.execute({ op: "map" }, ctx)).output
  expect(map).toContain("modules")
  expect(map).toContain("src/app")
  const missing = await tool.execute({ op: "outline" }, ctx)
  expect(missing.isError).toBe(true)
})

test("moduleOverview fits its budget and is empty for a single-module repo", async () => {
  const root = fixtureRepo()
  const db = GraphDb.open(":memory:")
  await syncRepo(root, db)
  expect(moduleOverview(db, 250)).toContain("src/app (1 files) → core")
  const single = GraphDb.open(":memory:")
  single.upsertFile("a.ts", "h", [
    { kind: "def", name: "only", symbolKind: "function", row: 0, endRow: 0 },
  ])
  expect(moduleOverview(single)).toBe("")
  expect(renderProjectMap(single)).toContain("1 files")
})

test("focusedSkeleton names only what the message mentions — and nothing for prose", async () => {
  const root = fixtureRepo()
  const db = GraphDb.open(":memory:")
  await syncRepo(root, db)
  expect(focusedSkeleton(db, "thanks, that looks great")).toBe("")
  const hit = focusedSkeleton(db, "make createStore validate the name, see src/app/main.ts")
  expect(hit).toContain("function createStore — src/core/store.ts:1")
  expect(hit).toContain("src/app/main.ts — bootApplication:3")
})

test("in a git repo the file list honours .gitignore", () => {
  const root = fixtureRepo()
  write(root, "generated/huge.ts", "export const generatedThing = 1\n")
  write(root, ".gitignore", "generated/\n")
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  const files = listSourceFiles(root)
  expect(files).toContain("src/core/store.ts")
  expect(files).not.toContain("generated/huge.ts")
})
