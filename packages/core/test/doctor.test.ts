import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type DoctorCatalog,
  type DoctorReport,
  doctor,
  renderDoctorReport,
} from "../src/context/doctor"
import { now } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeConfig(cwd: string, contents: string): void {
  mkdirSync(join(cwd, ".butterfly"), { recursive: true })
  writeFileSync(join(cwd, ".butterfly", "butterfly.jsonc"), contents)
}

test("prefix breakdown estimates tokens from the caller-supplied prefix pieces", () => {
  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "x".repeat(400), // 100 tok
    memoryText: "y".repeat(40), // 10 tok
    skillsIndexText: "z".repeat(20), // 5 tok
    graphSkeletonText: "w".repeat(80), // 20 tok
  })
  expect(report.prefix).toEqual({
    systemTokens: 100,
    memoryTokens: 10,
    skillsTokens: 5,
    graphSkeletonTokens: 20,
    graphAvailable: true,
  })
})

test("graphAvailable defaults to true, but a caller can report the graph as never-built", () => {
  const defaulted = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(defaulted.prefix.graphAvailable).toBe(true)

  const uninitialized = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    graphAvailable: false,
  })
  expect(uninitialized.prefix.graphAvailable).toBe(false)
})

test("missing graph skeleton text is treated as zero, not an error", () => {
  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.prefix.graphSkeletonTokens).toBe(0)
})

test("no session yet reports a zeroed, path-less journal section", () => {
  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.journal).toEqual({
    events: 0,
    bytes: 0,
    prunedEvents: 0,
    prunedCalls: 0,
    compactions: 0,
  })
})

test("journal section counts events, bytes, prunes, and compactions from what's on disk", () => {
  const sessionsDir = tempDir("bfly-doc-sessions-")
  const journal = SessionJournal.create(sessionsDir)
  journal.append({ type: "message.user", id: "1", text: "hello", time: now() })
  journal.append({ type: "tool.pruned", callIds: ["a", "b"], time: now() })
  journal.append({ type: "tool.pruned", callIds: ["c"], time: now() })
  journal.append({ type: "session.compacted", summary: "s", keepFromIndex: 0, time: now() })

  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    journalPath: journal.path,
  })
  expect(report.journal.path).toBe(journal.path)
  expect(report.journal.events).toBe(4)
  expect(report.journal.bytes).toBeGreaterThan(0)
  expect(report.journal.prunedEvents).toBe(2)
  expect(report.journal.prunedCalls).toBe(3)
  expect(report.journal.compactions).toBe(1)
})

test("mcp savings pass through per-server, with saved tokens derived", () => {
  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    mcpHub: {
      serverTokenSavings: () => [
        { name: "docs", eagerTokens: 900, indexTokens: 80 },
        { name: "broken", eagerTokens: 0, indexTokens: 5 },
      ],
    },
  })
  expect(report.mcp).toEqual([
    { name: "docs", eagerTokens: 900, indexTokens: 80, savedTokens: 820 },
    { name: "broken", eagerTokens: 0, indexTokens: 5, savedTokens: -5 },
  ])
})

test("no mcp hub yields an empty savings list, not an error", () => {
  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.mcp).toEqual([])
})

test("mcpConfigured lists configured-but-unverified servers, deduped against measured ones", () => {
  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    mcpHub: { serverTokenSavings: () => [{ name: "docs", eagerTokens: 900, indexTokens: 80 }] },
    mcpConfiguredNames: ["docs", "extra"],
  })
  expect(report.mcp).toEqual([
    { name: "docs", eagerTokens: 900, indexTokens: 80, savedTokens: 820 },
  ])
  expect(report.mcpConfigured).toEqual(["extra"])
})

test("mcpConfigured is empty when nothing is configured", () => {
  const report = doctor({
    cwd: tempDir("bfly-doc-"),
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.mcpConfigured).toEqual([])
})

test("config lint: a leading VAR=value assignment doesn't hide a genuinely dead hook command", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(
    cwd,
    `{ "hooks": [{ "event": "post.tool", "command": "CI=true definitely-not-a-real-binary-xyz123" }] }`,
  )
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  const issue = report.configLint.find((i) => i.kind === "dead-hook")
  expect(issue?.message).toContain("definitely-not-a-real-binary-xyz123")
  expect(issue?.message).not.toContain('"CI=true"')
})

test("config lint: a hook wrapped in shell subshell syntax is unverifiable, not dead", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(
    cwd,
    `{ "hooks": [{ "event": "post.tool", "command": "(cd sub && definitely-not-a-real-binary-xyz123)" }] }`,
  )
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.configLint.filter((i) => i.kind === "dead-hook")).toEqual([])
})

test("config lint: a missing catalog cache skips per-model lookups and notes the cause once", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "ollama/qwen3:8b", "small_model": "ollama/tiny" }`)
  const catalog: DoctorCatalog = { lookup: () => undefined } // would flag everything if actually queried
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    catalog,
    catalogStatus: "missing",
  })
  expect(report.configLint.filter((i) => i.kind === "unknown-model")).toEqual([])
  const staleIssues = report.configLint.filter((i) => i.kind === "catalog-stale")
  expect(staleIssues.length).toBe(1)
  expect(staleIssues[0]?.message).toContain("no local models.dev cache yet")
})

test("config lint: a stale catalog still runs lookups but adds one heads-up note", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "ollama/qwen3:8b" }`)
  const catalog: DoctorCatalog = {
    lookup: (providerId, modelId) =>
      providerId === "ollama" && modelId === "qwen3:8b" ? {} : undefined,
  }
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    catalog,
    catalogStatus: "stale",
  })
  expect(report.configLint.filter((i) => i.kind === "unknown-model")).toEqual([])
  const staleIssues = report.configLint.filter((i) => i.kind === "catalog-stale")
  expect(staleIssues.length).toBe(1)
  expect(staleIssues[0]?.message).toContain("stale")
})

test("config lint: flags an unknown top-level key via zod strict-parse diff", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "ollama/qwen3:8b", "totallyBogusKey": true }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  const issue = report.configLint.find((i) => i.kind === "unknown-key")
  expect(issue?.message).toContain("totallyBogusKey")
})

test("config lint: flags a hook whose command doesn't resolve on PATH", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(
    cwd,
    `{ "hooks": [{ "event": "post.tool", "command": "definitely-not-a-real-binary-xyz123 --flag" }] }`,
  )
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  const issue = report.configLint.find((i) => i.kind === "dead-hook")
  expect(issue?.message).toContain("definitely-not-a-real-binary-xyz123")
})

test("config lint: a hook running a real builtin is not flagged as dead", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "hooks": [{ "event": "post.tool", "command": "true" }] }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.configLint.filter((i) => i.kind === "dead-hook")).toEqual([])
})

test("config lint: flags an unknown hook event name even though the typed config could never carry one", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "hooks": [{ "event": "tool.finished", "command": "true" }] }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  const issue = report.configLint.find((i) => i.kind === "dead-hook")
  expect(issue?.message).toContain("tool.finished")
})

test("config lint: a disabled hook (enabled:false) with a dead command is NOT flagged", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(
    cwd,
    `{ "hooks": [{ "event": "post.tool", "command": "definitely-not-a-real-binary-xyz123", "enabled": false }] }`,
  )
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.configLint.filter((i) => i.kind === "dead-hook")).toEqual([])
})

test("config lint: an unknown event name is still flagged even when the hook is disabled", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "hooks": [{ "event": "tool.finished", "command": "true", "enabled": false }] }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  const issue = report.configLint.find((i) => i.kind === "dead-hook")
  expect(issue?.message).toContain("tool.finished")
})

test("config lint: flags a model id the catalog doesn't know about", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "ollama/no-such-model" }`)
  const catalog: DoctorCatalog = {
    lookup: (providerId, modelId) =>
      providerId === "ollama" && modelId === "qwen3:8b" ? {} : undefined,
  }
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    catalog,
  })
  const issue = report.configLint.find((i) => i.kind === "unknown-model")
  expect(issue?.message).toContain("ollama/no-such-model")
})

test("config lint: a malformed model reference (no slash) is flagged too", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "not-a-valid-ref" }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  const issue = report.configLint.find((i) => i.kind === "unknown-model")
  expect(issue?.message).toContain("not-a-valid-ref")
})

test("config lint: flags a missing provider key referenced by the configured model", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "anthropic/claude-sonnet-4-6" }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    env: {},
  })
  const issue = report.configLint.find((i) => i.kind === "missing-provider-key")
  expect(issue?.message).toContain("ANTHROPIC_API_KEY")
})

test("config lint: an env-supplied provider key clears the missing-key warning", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "anthropic/claude-sonnet-4-6" }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
  })
  expect(report.configLint.filter((i) => i.kind === "missing-provider-key")).toEqual([])
})

test("a clean, well-formed config produces zero lint issues", () => {
  const cwd = tempDir("bfly-doc-")
  writeConfig(cwd, `{ "model": "ollama/qwen3:8b" }`)
  const report = doctor({
    cwd,
    home: tempDir("bfly-doc-home-"),
    system: "",
    memoryText: "",
    skillsIndexText: "",
  })
  expect(report.configLint).toEqual([])
})


function sampleReport(): DoctorReport {
  return {
    prefix: {
      systemTokens: 1200,
      memoryTokens: 40,
      skillsTokens: 10,
      graphSkeletonTokens: 250,
      graphAvailable: true,
    },
    journal: {
      path: "/tmp/s.jsonl",
      events: 42,
      bytes: 8192,
      prunedEvents: 2,
      prunedCalls: 5,
      compactions: 1,
    },
    mcp: [{ name: "docs", eagerTokens: 900, indexTokens: 80, savedTokens: 820 }],
    mcpConfigured: ["extra"],
    configLint: [{ kind: "missing-provider-key", message: "model needs ANTHROPIC_API_KEY" }],
  }
}

test("renderDoctorReport renders every section plus lint issues, no bars by default", () => {
  const text = renderDoctorReport(sampleReport())
  expect(text).toContain("1,200 tok")
  expect(text).toContain("events          42")
  expect(text).toContain("saving ~820 tok/turn")
  expect(text).toContain("extra  configured, not verified")
  expect(text).toContain("[missing-provider-key]")
  expect(text).toContain("config lint: 1 issue(s)")
  expect(text).not.toContain("█") // no bar option supplied
})

test("renderDoctorReport appends a caller-supplied bar after each prefix token count", () => {
  const text = renderDoctorReport(sampleReport(), { bar: (tokens) => `[BAR:${tokens}]` })
  expect(text).toContain("~1,200 tok[BAR:1200]")
  expect(text).toContain("~250 tok[BAR:250]")
})

test("renderDoctorReport shows 'not initialized' instead of a token count when the graph was never built", () => {
  const report = sampleReport()
  report.prefix.graphAvailable = false
  const text = renderDoctorReport(report)
  expect(text).toContain("not initialized")
  expect(text).not.toContain("~250 tok")
})

test("renderDoctorReport reports a clean bill of health with no session yet", () => {
  const report: DoctorReport = {
    prefix: {
      systemTokens: 0,
      memoryTokens: 0,
      skillsTokens: 0,
      graphSkeletonTokens: 0,
      graphAvailable: true,
    },
    journal: { events: 0, bytes: 0, prunedEvents: 0, prunedCalls: 0, compactions: 0 },
    mcp: [],
    mcpConfigured: [],
    configLint: [],
  }
  const text = renderDoctorReport(report)
  expect(text).toContain("no session yet")
  expect(text).toContain("no MCP servers connected")
  expect(text).toContain("config lint: clean")
})
