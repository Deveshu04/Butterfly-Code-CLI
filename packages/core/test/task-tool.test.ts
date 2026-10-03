import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { type PermissionRules, resolvePermission } from "../src/permission/tree"
import { SessionJournal } from "../src/session/journal"
import { type ToolContext, ToolRegistry } from "../src/tool/registry"
import { runCommand } from "../src/tool/shell"
import { editTool } from "../src/tool/tools/edit"
import {
  createTaskTool,
  mergeWorktreeRules,
  mutatingSubagentRegistry,
  runSubagentTurn,
} from "../src/tool/tools/task"
import { worktreesRoot } from "../src/tool/worktree"
import { MockProvider } from "./helpers/mock-provider"
import { nonRepoDir } from "./helpers/temp"

const usage = { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 }

const TUI_LIKE_RULES: PermissionRules = {
  "*": "allow",
  bash: "ask",
  edit: { "*": "ask", "**/.env*": "deny", ".env*": "deny" },
  web: "ask",
}

async function gitFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "bfly-task-wt-repo-"))
  await runCommand("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  })
  writeFileSync(join(dir, "app.ts"), "export const v = 1\n")
  await runCommand("git add -A && git commit -qm init", { cwd: dir })
  return dir
}

test("task subagent runs isolated and returns only a summary", async () => {
  const provider = new MockProvider([
    // Subagent: one tool call, then a long answer.
    [
      { type: "tool-call", callId: "s1", name: "probe", input: { q: "find it" } },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: `FOUND: the answer. ${"x".repeat(3_000)}` },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const makeRegistry = () => {
    const registry = new ToolRegistry()
    registry.register({
      name: "probe",
      description: "Probes.",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ output: "probe data ".repeat(100) }),
    })
    return registry
  }
  const sessionsDir = mkdtempSync(join(tmpdir(), "bfly-task-"))
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "sub system",
    cwd: "/w",
    sessionsDir,
    makeRegistry,
  })

  const result = await tool.execute(
    { task: "find the answer" },
    { cwd: "/w", rules: { "*": "allow" }, state: {} },
  )

  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("FOUND: the answer.")
  expect(result.output.length).toBeLessThanOrEqual(2_200)
  // The subagent got its own journal in sessionsDir.
  expect(readdirSync(sessionsDir).some((f) => f.endsWith(".jsonl"))).toBe(true)
})

test("subagent rules are read-only: edit is denied inside the task", async () => {
  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "s1",
        name: "edit",
        input: { file_path: "x", old_string: "a", new_string: "b" },
      },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "could not edit, as expected" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  let edits = 0
  const makeRegistry = () => {
    const registry = new ToolRegistry()
    registry.register({
      name: "edit",
      description: "Edits.",
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      execute: async () => {
        edits += 1
        return { output: "edited" }
      },
    })
    return registry
  }
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: "/w",
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task2-")),
    makeRegistry,
  })
  const result = await tool.execute(
    { task: "try to edit" },
    { cwd: "/w", rules: { "*": "allow" }, state: {} },
  )
  expect(edits).toBe(0)
  expect(result.isError).toBeFalsy()
})

test("runSubagentTurn is a reusable seam: same isolated-journal + capped-summary behavior, callable directly (no task tool wrapper needed)", async () => {
  const provider = new MockProvider([
    [
      { type: "text-delta", text: `direct call worked. ${"y".repeat(3_000)}` },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const sessionsDir = mkdtempSync(join(tmpdir(), "bfly-subagent-seam-"))
  const result = await runSubagentTurn(
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "custom caller's own framing — no generic task-tool prompt suffix",
      cwd: "/w",
      sessionsDir,
      makeRegistry: () => new ToolRegistry(),
    },
    "a fully custom prompt, e.g. a /review rubric embedding a diff",
  )
  expect(result.summary).toContain("direct call worked.")
  expect(result.summary.length).toBeLessThanOrEqual(2_200)
  expect(result.journalPath).toContain(sessionsDir)
  expect(readdirSync(sessionsDir).some((f) => f.endsWith(".jsonl"))).toBe(true)
  expect(result.usage.input + result.usage.output).toBeGreaterThan(0)
})

test("worktree isolation: an edit lands in the worktree (not the main tree); a dirty worktree is reported with its path and left in place", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "s1",
        name: "edit",
        input: {
          file_path: "app.ts",
          old_string: "export const v = 1\n",
          new_string: "export const v = 2\n",
        },
      },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "bumped v to 2" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const sessionsDir = mkdtempSync(join(tmpdir(), "bfly-task-wt-sessions-"))
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir,
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => {
      const registry = new ToolRegistry()
      registry.register(editTool)
      return registry
    },
  })

  const result = await tool.execute(
    { task: "bump v to 2", isolation: "worktree" },
    { cwd: dir, rules: { "*": "allow" }, state: {} },
  )

  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("bumped v to 2")
  const meta = result.meta as { journal?: string; worktree: { path: string; dirty: boolean } }
  expect(meta.worktree.dirty).toBe(true)
  expect(result.output).toContain(meta.worktree.path)

  // Main tree never touched.
  expect(readFileSync(join(dir, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 1\n",
  )
  // The worktree, which lives under .butterfly/worktrees, got the edit.
  expect(meta.worktree.path.startsWith(worktreesRoot(dir))).toBe(true)
  expect(readFileSync(join(meta.worktree.path, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 2\n",
  )
  // Dirty worktree is left in place, not auto-merged/removed.
  expect(existsSync(meta.worktree.path)).toBe(true)

  // The isolated subagent's own journal notes the isolation + path.
  expect(meta.journal).toBeDefined()
  const { events } = SessionJournal.replay(meta.journal ?? "")
  const userMsg = events.find((e) => e.type === "message.user")
  expect(userMsg && "text" in userMsg ? userMsg.text : "").toContain(meta.worktree.path)
}, 30_000)

test("worktree isolation: a clean worktree (no changes made) is removed and pruned automatically", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "investigated, nothing to change" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-sessions2-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => {
      const registry = new ToolRegistry()
      registry.register(editTool)
      return registry
    },
  })

  const result = await tool.execute(
    { task: "investigate only", isolation: "worktree" },
    { cwd: dir, rules: { "*": "allow" }, state: {} },
  )

  expect(result.isError).toBeFalsy()
  const meta = result.meta as { worktree: { path: string; dirty: boolean; cleaned: boolean } }
  expect(meta.worktree.dirty).toBe(false)
  expect(meta.worktree.cleaned).toBe(true)
  expect(existsSync(meta.worktree.path)).toBe(false)
}, 30_000)

test("worktree isolation in a folder without git initializes one (snapshot commit, secrets excluded) and runs", async () => {
  const dir = nonRepoDir("bfly-task-wt-nogit-")
  writeFileSync(join(dir, "app.ts"), "export const a = 1\n")
  writeFileSync(join(dir, ".env"), "SECRET=1\n")
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "looked around" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-sessions3-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => new ToolRegistry(),
  })
  const progress: string[] = []
  const result = await tool.execute(
    { task: "x", isolation: "worktree" },
    { cwd: dir, rules: { "*": "allow" }, state: {}, progress: (line) => progress.push(line) },
  )
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("looked around")
  expect(result.output).toContain("this folder was not a git repository, so one was initialized")
  expect(progress.some((line) => line.includes("initialized"))).toBe(true)
  const tracked = await runCommand("git ls-files", { cwd: dir })
  expect(tracked.stdout).toContain("app.ts")
  expect(tracked.stdout).not.toContain(".env")
  expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".butterfly/")
}, 30_000)

test("an ask-mode session is told about the git setup in the one isolation prompt", async () => {
  const dir = nonRepoDir("bfly-task-wt-nogit-ask-")
  const notes: string[] = []
  const tool = createTaskTool({
    provider: () => new MockProvider([]),
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-sessions4-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => new ToolRegistry(),
  })
  const result = await tool.execute(
    { task: "x", isolation: "worktree" },
    {
      cwd: dir,
      rules: { "*": "ask" },
      state: {},
      ask: async (request) => {
        notes.push(request.note ?? "")
        return "deny"
      },
    },
  )
  expect(result.isError).toBe(true)
  expect(notes[0]).toContain("not a git repository, so one will be initialized here")
  // Denied: nothing was created.
  expect(existsSync(join(dir, ".git"))).toBe(false)
}, 20_000)

test("automatic git setup refuses a home folder, a filesystem root, or a huge tree", async () => {
  const { autoGitRefusal, ensureGitForWorktrees } = await import("../src/tool/worktree")
  const dir = nonRepoDir("bfly-task-wt-home-")
  expect(autoGitRefusal(dir, dir)).toContain("home folder")
  expect(autoGitRefusal("/", "/nowhere")).toContain("filesystem root")
  const refused = await ensureGitForWorktrees(dir, { home: dir })
  expect(refused.ok).toBe(false)
  expect(existsSync(join(dir, ".git"))).toBe(false)
})

test("a repository with no commits gets a first snapshot commit", async () => {
  const { ensureGitForWorktrees, worktreeGitState } = await import("../src/tool/worktree")
  const dir = nonRepoDir("bfly-task-wt-empty-")
  await runCommand("git init -q", { cwd: dir })
  writeFileSync(join(dir, "a.txt"), "a\n")
  expect(await worktreeGitState(dir)).toBe("no-commits")
  expect(await ensureGitForWorktrees(dir)).toEqual({ ok: true, did: "first-commit" })
  expect(await worktreeGitState(dir)).toBe("ready")
}, 20_000)

test("worktree isolation is denied harness-side when the caller's rules deny edit and bash (plan mode)", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-sessions4-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => new ToolRegistry(),
  })
  const planLikeRules = { "*": "allow" as const, bash: "deny" as const, edit: "deny" as const }

  const result = await tool.execute(
    { task: "x", isolation: "worktree" },
    { cwd: dir, rules: planLikeRules, state: {} },
  )

  expect(result.isError).toBe(true)
  expect(result.output.toLowerCase()).toContain("permission")
  expect(provider.requests.length).toBe(0)
  // No worktree should have been created.
  expect(existsSync(worktreesRoot(dir))).toBe(false)
}, 20_000)


test("mutatingSubagentRegistry is the read-only set PLUS edit+bash, and takes caller extras", () => {
  const registry = mutatingSubagentRegistry((sub) => {
    sub.register({
      name: "explore",
      description: "x",
      inputSchema: z.object({}),
      execute: async () => ({ output: "" }),
    })
  })
  const names = registry.list().map((tool) => tool.name)
  expect(names).toContain("read")
  expect(names).toContain("glob")
  expect(names).toContain("grep")
  expect(names).toContain("edit")
  expect(names).toContain("bash")
  expect(names).toContain("explore")
  // No recursion: a subagent must not spawn subagents.
  expect(names).not.toContain("task")
})

test("mergeWorktreeRules: the session's DENY rules survive inside the worktree, allow/ask are superseded by the worktree defaults", () => {
  const session: PermissionRules = {
    "*": "ask",
    bash: "ask",
    edit: { "*": "ask", "secret.txt": "deny" },
    memory: "deny",
  }
  const merged = mergeWorktreeRules(session)
  // User deny wins over the worktree's blanket allow.
  expect(resolvePermission(merged, "edit", "secret.txt")).toBe("deny")
  expect(resolvePermission(merged, "memory", undefined)).toBe("deny")
  // The worktree defaults' own secret-file protection is kept.
  expect(resolvePermission(merged, "edit", ".env")).toBe("deny")
  expect(resolvePermission(merged, "edit", "app.ts")).toBe("allow")
  expect(resolvePermission(merged, "bash", "ls")).toBe("allow")
  // The session's ROOT posture is not inherited either.
  expect(resolvePermission(merged, "read", "app.ts")).toBe("allow")
})

test("mergeWorktreeRules: a blanket tool deny stays a blanket deny", () => {
  const merged = mergeWorktreeRules({ "*": "allow", bash: "deny" })
  expect(resolvePermission(merged, "bash", "rm -rf /")).toBe("deny")
  expect(resolvePermission(merged, "bash", undefined)).toBe("deny")
})

test("worktree isolation: the session's deny rules are enforced INSIDE the worktree (user deny > worktree allow)", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "secret.txt"), "top secret\n")
  await runCommand("git add -A && git commit -qm secret", { cwd: dir })
  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "s1",
        name: "edit",
        input: { file_path: "secret.txt", old_string: "top secret\n", new_string: "leaked\n" },
      },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      {
        type: "tool-call",
        callId: "s2",
        name: "edit",
        input: {
          file_path: "app.ts",
          old_string: "export const v = 1\n",
          new_string: "export const v = 2\n",
        },
      },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "secret edit was denied, as configured" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-deny-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => mutatingSubagentRegistry(),
  })

  const result = await tool.execute(
    { task: "leak the secret", isolation: "worktree" },
    { cwd: dir, rules: { "*": "allow", edit: { "*": "allow", "secret.txt": "deny" } }, state: {} },
  )

  const meta = result.meta as { worktree: { path: string } }
  expect(
    readFileSync(join(meta.worktree.path, "secret.txt"), "utf8").replaceAll("\r\n", "\n"),
  ).toBe("top secret\n")
  expect(readFileSync(join(meta.worktree.path, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 2\n",
  )
}, 30_000)

test("worktree isolation: an 'ask' session (TUI defaults) is approved ONCE at entry, then the subagent works uninterrupted", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([
    [
      {
        type: "tool-call",
        callId: "s1",
        name: "edit",
        input: {
          file_path: "app.ts",
          old_string: "export const v = 1\n",
          new_string: "export const v = 2\n",
        },
      },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "bumped v" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const asks: string[] = []
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-ask-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => mutatingSubagentRegistry(),
  })

  const result = await tool.execute(
    { task: "bump v", isolation: "worktree" },
    {
      cwd: dir,
      rules: TUI_LIKE_RULES,
      state: {},
      ask: async (request) => {
        asks.push(`${request.tool}:${request.target ?? ""}`)
        return "allow"
      },
    },
  )

  expect(result.isError).toBeFalsy()
  expect(asks.length).toBe(1)
  expect(asks[0]).toContain("worktree")
  const meta = result.meta as { worktree: { path: string } }
  expect(readFileSync(join(meta.worktree.path, "app.ts"), "utf8").replaceAll("\r\n", "\n")).toBe(
    "export const v = 2\n",
  )
}, 30_000)

test("worktree isolation: denying the entry approval spends no turn and creates no worktree", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-ask-deny-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => mutatingSubagentRegistry(),
  })

  const result = await tool.execute(
    { task: "x", isolation: "worktree" },
    { cwd: dir, rules: TUI_LIKE_RULES, state: {}, ask: async () => "deny" },
  )

  expect(result.isError).toBe(true)
  expect(result.output.toLowerCase()).toContain("denied")
  expect(provider.requests.length).toBe(0)
  expect(existsSync(worktreesRoot(dir))).toBe(false)
}, 20_000)

test("worktree isolation: an 'ask' session with no approver (headless) is refused, not silently allowed", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-ask-none-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => mutatingSubagentRegistry(),
  })

  const result = await tool.execute(
    { task: "x", isolation: "worktree" },
    { cwd: dir, rules: TUI_LIKE_RULES, state: {} },
  )

  expect(result.isError).toBe(true)
  expect(result.output.toLowerCase()).toContain("approval")
  expect(provider.requests.length).toBe(0)
  expect(existsSync(worktreesRoot(dir))).toBe(false)
}, 20_000)

test("worktree isolation: a FAILED cleanup is reported honestly (still on disk, cleaned:false), never claimed as cleaned", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "s1", name: "lockit", input: {} },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "nothing to change" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-lock-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () =>
      mutatingSubagentRegistry((sub) => {
        sub.register({
          name: "lockit",
          description: "Locks this worktree.",
          inputSchema: z.object({}),
          execute: async (_input: unknown, ctx: ToolContext) => {
            await runCommand(`git worktree lock "${ctx.cwd}"`, { cwd: ctx.cwd })
            return { output: "locked" }
          },
        })
      }),
  })

  const result = await tool.execute(
    { task: "investigate", isolation: "worktree" },
    { cwd: dir, rules: { "*": "allow" }, state: {} },
  )

  const meta = result.meta as { worktree: { path: string; cleaned: boolean } }
  expect(meta.worktree.cleaned).toBe(false)
  expect(existsSync(meta.worktree.path)).toBe(true)
  expect(result.output).toContain(meta.worktree.path)
  expect(result.output.toLowerCase()).not.toContain("cleaned up automatically")
  expect(result.output.toLowerCase()).toContain("cleanup")
}, 30_000)

test("worktree isolation: uncommitted main-tree changes are warned about in BOTH the subagent prompt and the parent output", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 99 // uncommitted\n")
  const provider = new MockProvider([
    [
      { type: "text-delta", text: "looked around" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const tool = createTaskTool({
    provider: () => provider,
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-headonly-")),
    makeRegistry: () => new ToolRegistry(),
    makeMutatingRegistry: () => mutatingSubagentRegistry(),
  })

  const result = await tool.execute(
    { task: "look around", isolation: "worktree" },
    { cwd: dir, rules: { "*": "allow" }, state: {} },
  )

  expect(result.output.toLowerCase()).toContain("uncommitted")
  const meta = result.meta as { journal?: string }
  const { events } = SessionJournal.replay(meta.journal ?? "")
  const userMsg = events.find((event) => event.type === "message.user")
  const text = userMsg && "text" in userMsg ? userMsg.text : ""
  expect(text.toLowerCase()).toContain("uncommitted")
}, 30_000)

test("worktree isolation is refused when the caller registered no mutating registry", async () => {
  const dir = await gitFixture()
  const tool = createTaskTool({
    provider: () => new MockProvider([]),
    model: () => "mock",
    system: () => "s",
    cwd: dir,
    sessionsDir: mkdtempSync(join(tmpdir(), "bfly-task-wt-sessions5-")),
    makeRegistry: () => new ToolRegistry(),
    // makeMutatingRegistry deliberately omitted.
  })

  const result = await tool.execute(
    { task: "x", isolation: "worktree" },
    { cwd: dir, rules: { "*": "allow" }, state: {} },
  )

  expect(result.isError).toBe(true)
  expect(result.output.toLowerCase()).toContain("not configured")
}, 20_000)
