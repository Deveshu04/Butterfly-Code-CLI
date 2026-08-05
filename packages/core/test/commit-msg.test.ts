import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildCommitMessagePrompt,
  COMMIT_MSG_PROMPT,
  generateCommitMessage,
  recentLogSubjects,
  stageAllTracked,
  writeCommitMessageFile,
} from "../src/session/commit-msg"
import { runCommand } from "../src/tool/shell"
import { MockProvider } from "./helpers/mock-provider"

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function gitFixture(): Promise<string> {
  const dir = tempDir("bfly-commit-")
  await runCommand("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  })
  writeFileSync(join(dir, "app.ts"), "export const v = 1\n")
  await runCommand('git add -A && git commit -qm "Core: initial scaffold"', { cwd: dir })
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")
  await runCommand('git add -A && git commit -qm "Core: bump version"', { cwd: dir })
  return dir
}


test("recentLogSubjects is empty outside a git repo", async () => {
  const dir = tempDir("bfly-nogit-")
  expect(await recentLogSubjects(dir)).toEqual([])
}, 20_000)

test("recentLogSubjects returns subjects newest-first", async () => {
  const dir = await gitFixture()
  const subjects = await recentLogSubjects(dir)
  expect(subjects[0]).toBe("Core: bump version")
  expect(subjects[1]).toBe("Core: initial scaffold")
}, 20_000)

test("recentLogSubjects respects the count option", async () => {
  const dir = await gitFixture()
  const subjects = await recentLogSubjects(dir, { count: 1 })
  expect(subjects.length).toBe(1)
  expect(subjects[0]).toBe("Core: bump version")
}, 20_000)


test("buildCommitMessagePrompt includes recent subjects as a style guide plus the diff", () => {
  const prompt = buildCommitMessagePrompt("--- a/x\n+++ b/x\n", ["Core: did a thing", "TUI: fix"])
  expect(prompt).toContain("Core: did a thing")
  expect(prompt).toContain("TUI: fix")
  expect(prompt).toContain("--- a/x")
})

test("buildCommitMessagePrompt omits the style section when there is no history yet", () => {
  const prompt = buildCommitMessagePrompt("--- a/x\n", [])
  expect(prompt).not.toContain("recent subjects")
  expect(prompt).toContain("--- a/x")
})


test("generateCommitMessage reports nothingStaged without ever calling the model", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([])
  const result = await generateCommitMessage({ cwd: dir, provider, model: "mock" })
  expect(result.nothingStaged).toBe(true)
  expect(result.message).toBe("")
  expect(provider.requests.length).toBe(0)
}, 20_000)

test("generateCommitMessage builds a prompt from the staged diff and returns the model's message", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 3\n")
  await runCommand("git add -A", { cwd: dir })

  const provider = new MockProvider([
    [
      { type: "text-delta", text: "Core: bump v to 3" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  ])
  const result = await generateCommitMessage({ cwd: dir, provider, model: "mock" })
  expect(result.nothingStaged).toBe(false)
  expect(result.message).toBe("Core: bump v to 3")
  expect(result.diffChars).toBeGreaterThan(0)
  const req = provider.requests[0]
  expect(req?.messages[0]).toEqual({ role: "system", content: COMMIT_MSG_PROMPT })
  expect(
    req?.messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("app.ts"),
    ),
  ).toBe(true)
}, 20_000)


test("stageAllTracked stages tracked modifications but not untracked files", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 9\n") // tracked modification
  writeFileSync(join(dir, "scratch.txt"), "untracked\n") // untracked

  const staged = await stageAllTracked(dir)
  expect(staged).toBe(true)

  const status = await runCommand("git status --porcelain", { cwd: dir })
  expect(status.stdout).toContain("M  app.ts")
  expect(status.stdout).toContain("?? scratch.txt")
}, 20_000)

test("stageAllTracked returns false outside a git repo", async () => {
  const dir = tempDir("bfly-nogit3-")
  expect(await stageAllTracked(dir)).toBe(false)
}, 20_000)


test("writeCommitMessageFile writes the message verbatim and returns the path", () => {
  const dir = tempDir("bfly-msgfile-")
  const path = writeCommitMessageFile(dir, "Core: a multi-line\n\nmessage body")
  expect(readFileSync(path, "utf8")).toBe("Core: a multi-line\n\nmessage body")
})

test("generateCommitMessage reports a git failure instead of offering to stage", async () => {
  const dir = tempDir("bfly-brokengit-")
  writeFileSync(join(dir, ".git"), "not a gitfile\n")
  const provider = new MockProvider([])
  const result = await generateCommitMessage({ cwd: dir, provider, model: "mock" })
  expect(provider.requests.length).toBe(0)
  expect(result.failure).toBeDefined()
  expect(result.failure?.exitCode).not.toBe(0)
  expect(result.failure?.stderr.toLowerCase()).toContain("fatal")
  expect(result.nothingStaged).toBe(false)
  expect(result.message).toBe("")
}, 20_000)
