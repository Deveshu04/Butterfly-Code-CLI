import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  expandMentions,
  extractMentions,
  listMentionCandidates,
  renderMentionBlock,
} from "../src/context/mentions"
import { GraphDb } from "../src/graph/db"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("extractMentions finds every @token, deduped, in order of first appearance", () => {
  expect(extractMentions("look at @src/app.tsx and also @src/index.ts please")).toEqual([
    "src/app.tsx",
    "src/index.ts",
  ])
  expect(extractMentions("@a.ts @a.ts @b.ts")).toEqual(["a.ts", "b.ts"])
  expect(extractMentions("no mentions here")).toEqual([])
})

test("extractMentions stops a token at whitespace or the next @", () => {
  expect(extractMentions("fix @src/app.ts@src/other.ts now")).toEqual([
    "src/app.ts",
    "src/other.ts",
  ])
})

test("extractMentions accepts a quoted token so paths with spaces round-trip", () => {
  expect(extractMentions('see @"docs/Getting Started.md" now')).toEqual(["docs/Getting Started.md"])
  // Quoted and unquoted tokens mixed in the same message.
  expect(extractMentions('review @"src/My File.ts" and @src/plain.ts please')).toEqual([
    "src/My File.ts",
    "src/plain.ts",
  ])
  // A bare unquoted mention with a space is not recovered: the picker must
  // quote on insert, and extractMentions only round-trips quoted tokens.
  expect(extractMentions("see @docs/Getting Started.md now")).toEqual(["docs/Getting"])
})

test("expandMentions resolves a quoted mention whose path contains spaces", () => {
  const cwd = tempDir("bfly-mentions-")
  mkdirSync(join(cwd, "docs"), { recursive: true })
  writeFileSync(join(cwd, "docs", "Getting Started.md"), "# welcome\n")

  const result = expandMentions(cwd, 'read @"docs/Getting Started.md" please')
  expect(result).toHaveLength(1)
  expect(result[0]?.path).toBe("docs/Getting Started.md")
  expect(result[0]?.content).toContain("# welcome")
})

test("expandMentions reads mentioned files that exist and skips ones that don't", () => {
  const cwd = tempDir("bfly-mentions-")
  mkdirSync(join(cwd, "src"), { recursive: true })
  writeFileSync(join(cwd, "src", "app.ts"), "export const x = 1\n")

  const result = expandMentions(cwd, "please review @src/app.ts and @src/missing.ts")
  expect(result).toHaveLength(1)
  expect(result[0]?.path).toBe("src/app.ts")
  expect(result[0]?.content).toContain("export const x = 1")
  expect(result[0]?.truncated).toBe(false)
})

test("expandMentions caps per-file content with head/tail elision", () => {
  const cwd = tempDir("bfly-mentions-")
  const big = `HEAD-MARK\n${"x".repeat(5_000)}\nTAIL-MARK`
  writeFileSync(join(cwd, "big.ts"), big)

  const result = expandMentions(cwd, "see @big.ts", { maxCharsPerFile: 200 })
  expect(result).toHaveLength(1)
  expect(result[0]?.truncated).toBe(true)
  expect(result[0]?.content.length).toBeLessThanOrEqual(200)
  expect(result[0]?.content).toContain("HEAD-MARK")
  expect(result[0]?.content).toContain("TAIL-MARK")
})

test("expandMentions returns [] when the text has no mentions", () => {
  const cwd = tempDir("bfly-mentions-")
  expect(expandMentions(cwd, "just a normal task, no ats")).toEqual([])
})

test("renderMentionBlock is empty for no mentions, else one section per file", () => {
  expect(renderMentionBlock([])).toBe("")
  const block = renderMentionBlock([
    { path: "src/app.ts", content: "const x = 1", truncated: false },
    { path: "src/b.ts", content: "const y = 2", truncated: true },
  ])
  expect(block).toContain("@src/app.ts")
  expect(block).toContain("const x = 1")
  expect(block).toContain("@src/b.ts")
  expect(block).toContain("const y = 2")
})

test("listMentionCandidates prefers the graph DB file list when non-empty", () => {
  const cwd = tempDir("bfly-mentions-")
  writeFileSync(join(cwd, "on-disk-only.ts"), "export {}\n")
  const db = GraphDb.open(":memory:")
  db.upsertFile("src/from-graph.ts", "hash1", [])
  const candidates = listMentionCandidates(cwd, db)
  expect(candidates).toEqual(["src/from-graph.ts"])
  db.close()
})

test("listMentionCandidates falls back to a harness-ignore-aware glob walk when the graph is empty", () => {
  const cwd = tempDir("bfly-mentions-")
  mkdirSync(join(cwd, "node_modules"), { recursive: true })
  writeFileSync(join(cwd, "node_modules", "ignored.ts"), "export {}\n")
  writeFileSync(join(cwd, "visible.ts"), "export {}\n")
  const db = GraphDb.open(":memory:")
  const candidates = listMentionCandidates(cwd, db)
  expect(candidates).toContain("visible.ts")
  expect(candidates).not.toContain("node_modules/ignored.ts")
  db.close()
})

test("listMentionCandidates falls back to glob when no db is passed at all", () => {
  const cwd = tempDir("bfly-mentions-")
  writeFileSync(join(cwd, "solo.ts"), "export {}\n")
  expect(listMentionCandidates(cwd)).toEqual(["solo.ts"])
})
