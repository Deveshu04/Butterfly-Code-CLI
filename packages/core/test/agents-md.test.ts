import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  AGENTS_MD_FRAGMENT_CAP_CHARS,
  AGENTS_MD_TOTAL_BUDGET_CHARS,
  agentsMdAncestors,
  reconcileAgentsMd,
  renderAgentsMdBlock,
} from "../src/context/agents-md"
import { assemble } from "../src/session/assembly"
import { type JournalHeader, now, type SessionEvent } from "../src/session/events"
import { SessionJournal } from "../src/session/journal"
import { project } from "../src/session/projector"
import { type RunnerDeps, runUserTurn } from "../src/session/runner"
import { ToolRegistry } from "../src/tool/registry"
import { MockProvider } from "./helpers/mock-provider"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Fixture tree: root + a/ + a/b/ (nested target) + unrelated/ (must never load). */
function buildFixture(cwd: string, opts?: { rootChars?: string; aChars?: string }) {
  writeFileSync(join(cwd, "AGENTS.md"), opts?.rootChars ?? "ROOT GUIDANCE\n")
  mkdirSync(join(cwd, "a", "b"), { recursive: true })
  writeFileSync(join(cwd, "a", "AGENTS.md"), opts?.aChars ?? "A GUIDANCE\n")
  writeFileSync(join(cwd, "a", "b", "c.ts"), "export const c = 1\n")
  mkdirSync(join(cwd, "unrelated"), { recursive: true })
  writeFileSync(join(cwd, "unrelated", "AGENTS.md"), "UNRELATED GUIDANCE — must never load\n")
}

function readCallEvent(path: string): SessionEvent {
  return { type: "tool.call", callId: "c1", name: "read", input: { file_path: path }, time: now() }
}

test("agentsMdAncestors walks up from a file's dir to the repo root, nearest first", () => {
  const cwd = tempDir("bfly-agentsmd-")
  buildFixture(cwd)
  const chain = agentsMdAncestors(join(cwd, "a", "b", "c.ts"), cwd)
  expect(chain).toEqual([join(cwd, "a", "AGENTS.md"), join(cwd, "AGENTS.md")])
})

test("reconcileAgentsMd loads root + nearest for a touched nested file, excludes unrelated", () => {
  const cwd = tempDir("bfly-agentsmd-")
  buildFixture(cwd)
  const events: SessionEvent[] = [readCallEvent("a/b/c.ts")]
  const result = reconcileAgentsMd(events, cwd)

  expect(result.skipped).toEqual([])
  expect(result.warning).toBeUndefined()
  // Injection order: root -> deep (nearest overrides in-model).
  expect(result.fragments.map((f) => f.relPath)).toEqual(["AGENTS.md", "a/AGENTS.md"])
  expect(result.fragments[0]?.content).toContain("ROOT GUIDANCE")
  expect(result.fragments[1]?.content).toContain("A GUIDANCE")
  expect(result.fragments.some((f) => f.relPath.includes("unrelated"))).toBe(false)
})

test("repo-root AGENTS.md loads on the first reconcile regardless of touched files", () => {
  const cwd = tempDir("bfly-agentsmd-")
  buildFixture(cwd)
  const result = reconcileAgentsMd([], cwd)
  expect(result.fragments.map((f) => f.relPath)).toEqual(["AGENTS.md"])
})

test("no AGENTS.md anywhere: reconcile is a no-op", () => {
  const cwd = tempDir("bfly-agentsmd-")
  mkdirSync(join(cwd, "a"), { recursive: true })
  writeFileSync(join(cwd, "a", "x.ts"), "export {}\n")
  const result = reconcileAgentsMd([readCallEvent("a/x.ts")], cwd)
  expect(result.fragments).toEqual([])
  expect(result.skipped).toEqual([])
})

test("also detects touches from @-mention blocks in message.user text, not just tool calls", () => {
  const cwd = tempDir("bfly-agentsmd-")
  buildFixture(cwd)
  const events: SessionEvent[] = [
    {
      type: "message.user",
      id: "u1",
      text: "[attached files — mentioned with @]\n--- @a/b/c.ts ---\nexport const c = 1\n",
      time: now(),
    },
  ]
  const result = reconcileAgentsMd(events, cwd)
  expect(result.fragments.map((f) => f.relPath)).toEqual(["AGENTS.md", "a/AGENTS.md"])
})

test("per-fragment cap: content beyond AGENTS_MD_FRAGMENT_CAP_CHARS is truncated with a visible marker, never hard-errors", () => {
  const cwd = tempDir("bfly-agentsmd-")
  const big = "x".repeat(AGENTS_MD_FRAGMENT_CAP_CHARS + 500)
  writeFileSync(join(cwd, "AGENTS.md"), big)
  const result = reconcileAgentsMd([], cwd)
  expect(result.fragments).toHaveLength(1)
  const fragment = result.fragments[0]
  expect(fragment?.truncated).toBe(true)
  expect(fragment?.content).toContain("[truncated]")
  expect(fragment?.content.length).toBeLessThanOrEqual(
    AGENTS_MD_FRAGMENT_CAP_CHARS + "\n[truncated]".length,
  )
})

test("dedup: two touched files sharing an ancestor only load that AGENTS.md once", () => {
  const cwd = tempDir("bfly-agentsmd-")
  buildFixture(cwd)
  writeFileSync(join(cwd, "a", "b", "d.ts"), "export const d = 1\n")
  const events: SessionEvent[] = [readCallEvent("a/b/c.ts"), readCallEvent("a/b/d.ts")]
  const result = reconcileAgentsMd(events, cwd)
  const paths = result.fragments.map((f) => f.relPath)
  expect(paths).toEqual(["AGENTS.md", "a/AGENTS.md"])
  expect(new Set(paths).size).toBe(paths.length)
})

test("dedup is case-insensitive on Windows/NTFS: mixed-casing touches of files under the same ancestor never double-load a fragment or double-count the budget", () => {
  const cwd = tempDir("bfly-agentsmd-")
  buildFixture(cwd)
  writeFileSync(join(cwd, "a", "b", "d.ts"), "export const d = 1\n")

  const events: SessionEvent[] = [readCallEvent("a/b/c.ts"), readCallEvent("A/B/d.ts")]
  const result = reconcileAgentsMd(events, cwd)

  const relPaths = result.fragments.map((f) => f.relPath.toLowerCase())
  expect(relPaths).toEqual(["agents.md", "a/agents.md"])
  // No duplicate fragment for the same physical AGENTS.md under different
  // casing, and the budget must only have been charged once per file.
  const identities = result.fragments.map((f) => f.path.toLowerCase())
  expect(new Set(identities).size).toBe(identities.length)

  // A follow-up reconcile (epoch semantics) with the differently-cased
  // touch replayed again must not reload anything either.
  const priorEvent: SessionEvent = {
    type: "context.fragment",
    source: "agents.md",
    fragments: result.fragments,
    time: now(),
  }
  const again = reconcileAgentsMd([...events, priorEvent], cwd)
  expect(again.fragments).toEqual([])
})

test("epoch reconcile: once a fragment is loaded (recorded in a prior context.fragment event) it is never reloaded", () => {
  const cwd = tempDir("bfly-agentsmd-")
  buildFixture(cwd)
  const first = reconcileAgentsMd([readCallEvent("a/b/c.ts")], cwd)
  expect(first.fragments.length).toBe(2)

  const priorEvent: SessionEvent = {
    type: "context.fragment",
    source: "agents.md",
    fragments: first.fragments,
    time: now(),
  }
  // Same touched file again (e.g. read a second time) — nothing new to load.
  const second = reconcileAgentsMd([readCallEvent("a/b/c.ts"), priorEvent], cwd)
  expect(second.fragments).toEqual([])
  expect(second.skipped).toEqual([])

  // A NEW touched file in an already-loaded subtree also yields nothing new.
  writeFileSync(join(cwd, "a", "e.ts"), "export const e = 1\n")
  const third = reconcileAgentsMd(
    [readCallEvent("a/b/c.ts"), priorEvent, readCallEvent("a/e.ts")],
    cwd,
  )
  expect(third.fragments).toEqual([])
})

test("total budget: beyond it, nearest fragments are preferred and a warning is recorded; the skip is not repeated", () => {
  const cwd = tempDir("bfly-agentsmd-")
  const cap = AGENTS_MD_FRAGMENT_CAP_CHARS // 2_000
  mkdirSync(join(cwd, "a", "b", "c"), { recursive: true })
  writeFileSync(join(cwd, "AGENTS.md"), "R".repeat(cap)) // depth 0 (root)
  writeFileSync(join(cwd, "a", "AGENTS.md"), "A".repeat(cap)) // depth 1
  writeFileSync(join(cwd, "a", "b", "AGENTS.md"), "B".repeat(cap)) // depth 2
  writeFileSync(join(cwd, "a", "b", "c", "AGENTS.md"), "C".repeat(cap)) // depth 3 (nearest)
  writeFileSync(join(cwd, "a", "b", "c", "d.ts"), "export const d = 1\n")

  const events: SessionEvent[] = [readCallEvent("a/b/c/d.ts")]
  const result = reconcileAgentsMd(events, cwd, { totalBudgetChars: AGENTS_MD_TOTAL_BUDGET_CHARS })

  // 6_000 budget / 2_000-char fragments = 3 accepted; root (shallowest) skipped.
  expect(result.fragments).toHaveLength(3)
  expect(result.fragments.map((f) => f.relPath)).toEqual([
    "a/AGENTS.md",
    "a/b/AGENTS.md",
    "a/b/c/AGENTS.md",
  ])
  expect(result.skipped).toHaveLength(1)
  expect(result.skipped[0]).toBe(join(cwd, "AGENTS.md"))
  expect(result.warning).toBeDefined()
  expect(result.warning).toContain("AGENTS.md")

  // Re-running reconcile with that context.fragment event folded in must not
  // repeat the warning or retry the skipped root fragment (budget only grows).
  const priorEvent: SessionEvent = {
    type: "context.fragment",
    source: "agents.md",
    fragments: result.fragments,
    skipped: result.skipped,
    ...(result.warning !== undefined ? { warning: result.warning } : {}),
    time: now(),
  }
  const again = reconcileAgentsMd([...events, priorEvent], cwd, {
    totalBudgetChars: AGENTS_MD_TOTAL_BUDGET_CHARS,
  })
  expect(again.fragments).toEqual([])
  expect(again.skipped).toEqual([])
  expect(again.warning).toBeUndefined()
})

test("renderAgentsMdBlock renders one section per fragment, empty string for none", () => {
  expect(renderAgentsMdBlock([])).toBe("")
  const block = renderAgentsMdBlock([
    { path: "/w/AGENTS.md", relPath: "AGENTS.md", content: "ROOT", truncated: false },
    { path: "/w/a/AGENTS.md", relPath: "a/AGENTS.md", content: "NESTED", truncated: false },
  ])
  expect(block).toContain("AGENTS.md")
  expect(block).toContain("ROOT")
  expect(block).toContain("a/AGENTS.md")
  expect(block).toContain("NESTED")
  // root's section must precede the nested one — nearest-wins ordering.
  expect(block.indexOf("ROOT")).toBeLessThan(block.indexOf("NESTED"))
})

test("assemble() renders a context.fragment event as an appended, labelled user message", () => {
  const t = now()
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "look at a/b/c.ts", time: t },
    {
      type: "context.fragment",
      source: "agents.md",
      fragments: [
        { path: "/w/AGENTS.md", relPath: "AGENTS.md", content: "ROOT GUIDANCE", truncated: false },
      ],
      time: t,
    },
  ]
  const messages = assemble({ system: "You are Butterfly.", timeline })
  expect(messages[0]).toEqual({ role: "system", content: "You are Butterfly." })
  expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"])
  const block = messages[2]?.role === "user" ? messages[2].content : ""
  expect(block).toContain("ROOT GUIDANCE")
})

test("assemble() skips a context.fragment event whose fragments are empty (warning-only bookkeeping)", () => {
  const t = now()
  const timeline: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "hi", time: t },
    { type: "context.fragment", source: "agents.md", fragments: [], warning: "budget", time: t },
  ]
  const messages = assemble({ system: "s", timeline })
  expect(messages.map((m) => m.role)).toEqual(["system", "user"])
})

test("runUserTurn integration: reading a nested file journals a context.fragment event and the NEXT provider call sees it; the frozen system prefix is untouched", async () => {
  const cwd = tempDir("bfly-agentsmd-run-")
  buildFixture(cwd)

  const usage1 = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }
  const usage2 = { input: 150, output: 20, cacheRead: 0, cacheWrite: 0 }
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "c1", name: "read", input: { file_path: "a/b/c.ts" } },
      { type: "finish", reason: "tool-calls", usage: usage1 },
    ],
    [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop", usage: usage2 },
    ],
  ])
  const registry = new ToolRegistry()
  registry.register({
    name: "read",
    description: "r",
    inputSchema: z.object({ file_path: z.string() }),
    execute: async () => ({ output: "export const c = 1" }),
  })
  const deps: RunnerDeps = {
    provider,
    registry,
    journal: SessionJournal.create(tempDir("bfly-agentsmd-journal-")),
    rules: { "*": "allow" },
    model: "mock-model",
    system: "You are Butterfly.",
    cwd,
  }
  await runUserTurn(deps, "read a/b/c.ts")

  const { events } = SessionJournal.replay(deps.journal.path)
  const fragmentEvents = events.filter((e) => e.type === "context.fragment")
  // Root loads eagerly at step 1 (before any tool runs — "first turn
  // regardless"); a/AGENTS.md loads at step 2 once a/b/c.ts was read.
  expect(fragmentEvents.length).toBe(2)
  if (
    fragmentEvents[0]?.type !== "context.fragment" ||
    fragmentEvents[1]?.type !== "context.fragment"
  ) {
    throw new Error("expected two context.fragment events")
  }
  expect(fragmentEvents[0].fragments.map((f) => f.relPath)).toEqual(["AGENTS.md"])
  expect(fragmentEvents[1].fragments.map((f) => f.relPath)).toEqual(["a/AGENTS.md"])

  // The very first provider call already sees the root fragment.
  const first = provider.requests[0]
  expect(first?.messages[0]).toEqual({ role: "system", content: "You are Butterfly." })
  const firstCombined = first?.messages.map((m) => ("content" in m ? m.content : "")).join("\n")
  expect(firstCombined).toContain("ROOT GUIDANCE")

  const second = provider.requests[1]
  expect(second?.messages[0]).toEqual({ role: "system", content: "You are Butterfly." })
  const combined = second?.messages.map((m) => ("content" in m ? m.content : "")).join("\n")
  expect(combined).toContain("ROOT GUIDANCE")
  expect(combined).toContain("A GUIDANCE")
})

test("a loaded AGENTS.md fragment survives compaction: still present in the ASSEMBLED provider messages after the cut (once loaded, it stays)", () => {
  const t = now()
  const header: JournalHeader = { v: 1, kind: "butterfly-session", sessionId: "s1", createdAt: t }
  const events: SessionEvent[] = [
    { type: "message.user", id: "u1", text: "look at a/b/c.ts", time: t }, // 0
    {
      type: "context.fragment",
      source: "agents.md",
      fragments: [
        { path: "/w/AGENTS.md", relPath: "AGENTS.md", content: "ROOT GUIDANCE", truncated: false },
      ],
      time: t,
    }, // 1 — loaded early, well before the compaction cut below
    { type: "message.assistant", id: "a1", text: "ok", time: t }, // 2
    { type: "tool.call", callId: "c1", name: "read", input: { file_path: "a/b/c.ts" }, time: t }, // 3
    { type: "tool.result", callId: "c1", output: "1\tcode", isError: false, time: t }, // 4
    { type: "message.assistant", id: "a2", text: "done", time: t }, // 5
    { type: "message.user", id: "u2", text: "keep going", time: t }, // 6 — the cut boundary
    // Compaction cuts everything before index 6 — including the
    // context.fragment event at index 1 — replacing it with a summary.
    { type: "session.compacted", summary: "did earlier work", keepFromIndex: 6, time: t },
    { type: "message.user", id: "u3", text: "continue", time: t },
  ]

  const projected = project(header, events)
  // The raw context.fragment event (index 1) is before keepFromIndex (6),
  // yet it must still be part of the effective/projected timeline.
  expect(projected.timeline.some((e) => e.type === "context.fragment")).toBe(true)

  const messages = assemble({ system: "s", timeline: projected.timeline })
  const combined = messages.map((m) => ("content" in m ? m.content : "")).join("\n")
  expect(combined).toContain("ROOT GUIDANCE")
})
