import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSystem } from "../src/context/system"
import { EpisodicIndex } from "../src/memory/episodic"
import type { MemoryPaths } from "../src/memory/files"
import { createMemoryTool } from "../src/memory/memory-tool"
import { createSkillTool } from "../src/memory/skill-tool"
import { now } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import type { ToolContext } from "../src/tool/registry"

function ctx(): ToolContext {
  return { cwd: "/w", rules: { "*": "allow" }, state: {} }
}

function tempPaths(): MemoryPaths {
  const dir = mkdtempSync(join(tmpdir(), "bfly-memtool-"))
  return { project: join(dir, "PROJECT.md"), user: join(dir, "USER.md") }
}

test("memory tool add writes and notes the frozen-until-next-session rule", async () => {
  const paths = tempPaths()
  const tool = createMemoryTool({ paths, episodic: () => undefined })
  const result = await tool.execute(
    { op: "add", scope: "project", text: "gates: bun test && bun run typecheck" },
    ctx(),
  )
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("next session")
  expect(readFileSync(paths.project, "utf8")).toContain("gates:")
})

test("memory tool search returns verbatim episodic hits", async () => {
  const journal = SessionJournal.create(mkdtempSync(join(tmpdir(), "bfly-memtool-epi-")))
  journal.append({
    type: "message.user",
    id: "u1",
    text: "the deploy failed with ECONNRESET on port 8443",
    time: now(),
  })
  const index = EpisodicIndex.open(":memory:")
  index.indexJournal(journal.path)

  const tool = createMemoryTool({ paths: tempPaths(), episodic: () => index })
  const result = await tool.execute({ op: "search", query: "ECONNRESET deploy" }, ctx())
  expect(result.output).toContain("ECONNRESET on port 8443")
  index.close()
})

test("memory tool write without scope is an actionable error", async () => {
  const tool = createMemoryTool({ paths: tempPaths(), episodic: () => undefined })
  const result = await tool.execute({ op: "add", text: "no scope" }, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("scope")
})

test("skill tool lists the index and loads bodies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bfly-skilltool-"))
  mkdirSync(join(dir, "release"), { recursive: true })
  writeFileSync(
    join(dir, "release", "SKILL.md"),
    "---\nname: release\ndescription: Cut a release safely\n---\n\n1. bump version\n2. tag\n",
  )
  const tool = createSkillTool({ dirs: [dir] })

  const list = await tool.execute({}, ctx())
  expect(list.output).toContain("release — Cut a release safely")

  const view = await tool.execute({ name: "release" }, ctx())
  expect(view.output).toContain("1. bump version")

  const missing = await tool.execute({ name: "ghost" }, ctx())
  expect(missing.isError).toBe(true)
})

test("system prefix embeds user memory and the skills index", () => {
  const system = buildSystem("m", {
    cwd: "/w",
    platform: "linux",
    date: "2026-08-04",
    projectMemory: "- gates: bun test",
    userMemory: "- prefers terse answers",
    skillsIndex: "release — Cut a release safely",
  })
  expect(system).toContain("gates: bun test")
  expect(system).toContain("prefers terse answers")
  expect(system).toContain("release — Cut a release safely")
})
