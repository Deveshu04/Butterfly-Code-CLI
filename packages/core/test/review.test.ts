import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assemble } from "../src/session/assembly"
import { SessionJournal } from "../src/session/journal"
import { project } from "../src/session/projector"
import {
  buildReviewPrompt,
  describeGitFailure,
  describeReviewScope,
  gatherDiff,
  journalReview,
  parseReviewArg,
  REVIEW_DIFF_MAX_CHARS,
  REVIEW_RUBRIC,
  runReview,
  validateRevisionRange,
} from "../src/session/review"
import { ToolRegistry } from "../src/tool/registry"
import { runCommand } from "../src/tool/shell"
import { MockProvider } from "./helpers/mock-provider"

const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function gitFixture(): Promise<string> {
  const dir = tempDir("bfly-review-")
  await runCommand("git init -q && git config user.email t@t && git config user.name t", {
    cwd: dir,
  })
  writeFileSync(join(dir, "app.ts"), "export const v = 1\n")
  await runCommand("git add -A && git commit -qm init", { cwd: dir })
  return dir
}

// --- gatherDiff ---

test("gatherDiff reports empty outside a git repo, no shell hang", async () => {
  const dir = tempDir("bfly-nogit-")
  const result = await gatherDiff(dir)
  expect(result).toEqual({ diff: "", truncated: false, empty: true })
}, 20_000)

test("gatherDiff reports empty for a clean repo with nothing to diff", async () => {
  const dir = await gitFixture()
  const result = await gatherDiff(dir)
  expect(result.empty).toBe(true)
  expect(result.diff).toBe("")
  expect(result.failure).toBeUndefined()
}, 20_000)

test("gatherDiff surfaces a failed git spawn instead of reporting it as nothing to review", async () => {
  const dir = await gitFixture()
  // A revision that cannot exist in this fixture's one-commit history: git
  // exits non-zero and writes the reason to stderr.
  const result = await gatherDiff(dir, { range: "HEAD~999" })
  expect(result.failure).toBeDefined()
  expect(result.failure?.exitCode).not.toBe(0)
  expect(result.failure?.timedOut).toBe(false)
  expect(result.failure?.command).toContain("HEAD~999")
  expect(result.failure?.stderr.toLowerCase()).toContain("fatal")
  expect(result.diff).toBe("")
}, 20_000)

test("describeGitFailure renders exit code + stderr head in one line-ish blurb", () => {
  const text = describeGitFailure({
    command: "git diff HEAD~999",
    exitCode: 128,
    stderr: "fatal: ambiguous argument 'HEAD~999': unknown revision",
    timedOut: false,
  })
  expect(text).toContain("git diff HEAD~999")
  expect(text).toContain("128")
  expect(text).toContain("unknown revision")

  const timedOut = describeGitFailure({
    command: "git diff",
    exitCode: 1,
    stderr: "",
    timedOut: true,
  })
  expect(timedOut.toLowerCase()).toContain("timed out")
})

test("gatherDiff combines unstaged and staged changes by default, each under its own header", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")
  writeFileSync(join(dir, "new.ts"), "export const w = 1\n")
  await runCommand("git add new.ts", { cwd: dir })

  const result = await gatherDiff(dir)
  expect(result.empty).toBe(false)
  expect(result.diff).toContain("unstaged changes")
  expect(result.diff).toContain("staged changes")
  expect(result.diff).toContain("app.ts")
  expect(result.diff).toContain("new.ts")
}, 20_000)

test("gatherDiff with staged:true only reports the index, not the working tree", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")
  writeFileSync(join(dir, "new.ts"), "export const w = 1\n")
  await runCommand("git add new.ts", { cwd: dir })

  const result = await gatherDiff(dir, { staged: true })
  expect(result.diff).toContain("new.ts")
  expect(result.diff).not.toContain("app.ts")
}, 20_000)

test("gatherDiff with a range diffs against that revision", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")
  await runCommand('git add -A && git commit -qm "second"', { cwd: dir })

  const result = await gatherDiff(dir, { range: "HEAD~1" })
  expect(result.empty).toBe(false)
  expect(result.diff).toContain("app.ts")
}, 20_000)

test("gatherDiff caps at ~20k chars with head/tail elision", async () => {
  const dir = await gitFixture()
  // A single file whose diff vastly exceeds the cap. Staged so `git diff
  // --staged` actually reports it (untracked files never show in a diff).
  writeFileSync(join(dir, "big.ts"), `${"x".repeat(40_000)}\n`)
  await runCommand("git add big.ts", { cwd: dir })
  const result = await gatherDiff(dir)
  expect(result.truncated).toBe(true)
  expect(result.diff.length).toBeLessThanOrEqual(REVIEW_DIFF_MAX_CHARS)
  expect(result.diff).toContain("elided")
}, 20_000)

// --- parseReviewArg ---

test("parseReviewArg: empty string means the default (unstaged+staged)", () => {
  expect(parseReviewArg("")).toEqual({})
  expect(parseReviewArg("   ")).toEqual({})
})

test("parseReviewArg: --staged selects the index only", () => {
  expect(parseReviewArg("--staged")).toEqual({ staged: true })
})

test("parseReviewArg: anything else is treated as a git revision range", () => {
  expect(parseReviewArg("HEAD~3")).toEqual({ range: "HEAD~3" })
  expect(parseReviewArg("main..feature")).toEqual({ range: "main..feature" })
})

test("describeReviewScope names what was reviewed for the transcript + journal", () => {
  expect(describeReviewScope({})).toContain("unstaged")
  expect(describeReviewScope({ staged: true })).toContain("staged")
  expect(describeReviewScope({ range: "HEAD~3" })).toContain("HEAD~3")
})

// --- buildReviewPrompt ---

test("buildReviewPrompt embeds the rubric and the diff verbatim", () => {
  const prompt = buildReviewPrompt("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n")
  expect(prompt).toContain(REVIEW_RUBRIC)
  expect(prompt).toContain("correctness")
  expect(prompt.toLowerCase()).toContain("tests")
  expect(prompt.toLowerCase()).toContain("security")
  expect(prompt.toLowerCase()).toContain("convention")
  expect(prompt.toLowerCase()).toContain("file:line")
  expect(prompt).toContain("-old\n+new")
})

// --- runReview: subagent invocation, read-only enforcement, summary cap ---

test("runReview skips the subagent entirely when there is nothing to review", async () => {
  const dir = tempDir("bfly-nogit2-")
  const provider = new MockProvider([])
  const sessionsDir = tempDir("bfly-review-sessions-")
  const result = await runReview(
    dir,
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "s",
      cwd: dir,
      sessionsDir,
      makeRegistry: () => new ToolRegistry(),
    },
    {},
  )
  expect(provider.requests.length).toBe(0)
  expect(result.journalPath).toBeUndefined()
  expect(result.summary.toLowerCase()).toContain("nothing to review")
}, 20_000)

test("runReview surfaces a git failure and never invokes the subagent", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([])
  const sessionsDir = tempDir("bfly-review-sessions-fail-")
  const result = await runReview(
    dir,
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "s",
      cwd: dir,
      sessionsDir,
      makeRegistry: () => new ToolRegistry(),
    },
    { range: "HEAD~999" },
  )
  expect(provider.requests.length).toBe(0)
  expect(result.journalPath).toBeUndefined()
  expect(result.failure).toBeDefined()
  expect(result.summary).toContain("git failed")
  expect(result.summary.toLowerCase()).not.toContain("nothing to review")
}, 20_000)

test("runReview spawns the read-only subagent machinery and caps the summary", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")

  const provider = new MockProvider([
    [
      { type: "text-delta", text: `LGTM. ${"x".repeat(3_000)}` },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const sessionsDir = tempDir("bfly-review-sessions2-")
  const result = await runReview(
    dir,
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "review system",
      cwd: dir,
      sessionsDir,
      makeRegistry: () => new ToolRegistry(), // no bash, no edit — read-only
    },
    {},
  )
  expect(result.journalPath).toBeDefined()
  expect(result.summary).toContain("LGTM.")
  expect(result.summary.length).toBeLessThanOrEqual(2_200)
  // The rubric + diff went to the model as the user turn.
  const req = provider.requests[0]
  expect(
    req?.messages.some(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("app.ts"),
    ),
  ).toBe(true)
}, 20_000)

test("runReview's subagent cannot execute bash — it is not part of the restricted registry", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")

  const provider = new MockProvider([
    [
      { type: "tool-call", callId: "b1", name: "bash", input: { command: "rm -rf /" } },
      { type: "finish", reason: "tool-calls", usage },
    ],
    [
      { type: "text-delta", text: "could not run bash, as expected" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const sessionsDir = tempDir("bfly-review-sessions3-")
  const result = await runReview(
    dir,
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "s",
      cwd: dir,
      sessionsDir,
      makeRegistry: () => new ToolRegistry(), // bash deliberately absent
    },
    {},
  )
  expect(result.journalPath).toBeDefined()
  const { events } = SessionJournal.replay(result.journalPath ?? "")
  const toolResult = events.find((e) => e.type === "tool.result")
  expect(toolResult && toolResult.type === "tool.result" ? toolResult.isError : false).toBe(true)
  expect(toolResult && toolResult.type === "tool.result" ? toolResult.output : "").toContain(
    "Unknown tool",
  )
  expect(result.summary).toContain("could not run bash")
}, 20_000)

// --- the review summary enters the MAIN conversation (journal = source of truth) ---

test("journalReview appends a session.review event that assembly makes model-visible", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")

  const provider = new MockProvider([
    [
      { type: "text-delta", text: "MINOR ISSUES: app.ts:1 magic number" },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const sessionsDir = tempDir("bfly-review-sessions4-")
  const result = await runReview(
    dir,
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "s",
      cwd: dir,
      sessionsDir,
      makeRegistry: () => new ToolRegistry(),
    },
    {},
  )

  const main = SessionJournal.create(tempDir("bfly-review-main-"))
  const event = journalReview(main, result, describeReviewScope({}))
  expect(event).toBeDefined()
  expect(event?.summary).toBe(result.summary)

  const { header, events } = SessionJournal.replay(main.path)
  const journaled = events.find((e) => e.type === "session.review")
  expect(journaled).toBeDefined()

  // (a) part of the model-visible conversation on the NEXT turn
  const timeline = project(header, events).timeline
  expect(timeline.some((e) => e.type === "session.review")).toBe(true)
  const messages = assemble({ system: "sys", timeline })
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .filter((content): content is string => typeof content === "string")
  expect(userText.some((text) => text.includes("MINOR ISSUES: app.ts:1 magic number"))).toBe(true)
  // (b) UI-only fields (subagent journal path) never reach the model
  const rendered = messages.map((m) => ("content" in m ? m.content : m.output)).join("\n")
  expect(rendered).not.toContain(result.journalPath ?? "@@never@@")
}, 20_000)

test("journalReview carries the existing ≤2k subagent summary cap into the conversation", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")

  const provider = new MockProvider([
    [
      { type: "text-delta", text: `LGTM. ${"y".repeat(5_000)}` },
      { type: "finish", reason: "stop", usage },
    ],
  ])
  const sessionsDir = tempDir("bfly-review-sessions5-")
  const result = await runReview(
    dir,
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "s",
      cwd: dir,
      sessionsDir,
      makeRegistry: () => new ToolRegistry(),
    },
    {},
  )
  const main = SessionJournal.create(tempDir("bfly-review-main2-"))
  const event = journalReview(main, result, describeReviewScope({}))
  expect(event?.summary.length).toBeLessThanOrEqual(2_200)
}, 20_000)

test("journalReview journals nothing when no subagent ran", async () => {
  const main = SessionJournal.create(tempDir("bfly-review-main3-"))
  const skipped = journalReview(
    main,
    { summary: "nothing to review — no diff found", diffChars: 0, truncated: false },
    "unstaged + staged changes",
  )
  expect(skipped).toBeUndefined()
  const failed = journalReview(
    main,
    {
      summary: "git failed: boom",
      diffChars: 0,
      truncated: false,
      failure: { command: "git diff x", exitCode: 128, stderr: "fatal", timedOut: false },
    },
    "git diff x",
  )
  expect(failed).toBeUndefined()
  expect(SessionJournal.replay(main.path).events.length).toBe(0)
})


test("validateRevisionRange accepts the revision forms git users actually type", () => {
  for (const range of [
    "HEAD~3",
    "HEAD^",
    "main..feature",
    "main...feature",
    "v1.2.3",
    "release/2026-08",
    "origin/main",
    "8f3a1c9",
    "HEAD@{2}",
    "HEAD^{tree}",
    "refs/heads/my-branch",
    "main feature",
  ]) {
    const verdict = validateRevisionRange(range)
    expect(verdict.ok ? verdict.range : `REJECTED: ${range}`).toBe(range)
  }
})

test("validateRevisionRange refuses shell metacharacters, option injection and absurd length", () => {
  for (const range of [
    "$(touch pwned)",
    "`touch pwned`",
    "HEAD~1; touch pwned",
    "HEAD~1 && touch pwned",
    "HEAD~1 | tee pwned",
    "HEAD~1 > pwned",
    'HEAD~1"',
    "HEAD~1'",
    "$HOME",
    "--output=pwned",
    "~/somewhere",
    "*",
    "a".repeat(201),
    "",
    "   ",
    "a b c d",
  ]) {
    expect(validateRevisionRange(range).ok).toBe(false)
  }
})

test("a $(...)-bearing range is rejected by parseReviewArg with no range to spawn", () => {
  const opts = parseReviewArg("$(touch pwned)")
  expect(opts.range).toBeUndefined()
  expect(opts.staged).toBeUndefined()
  expect(opts.rejected).toBeTruthy()
  expect(opts.rejected).toContain("revision")
})

test("gatherDiff refuses a rejected/invalid range BEFORE spawning anything", async () => {
  const dir = await gitFixture()
  const marker = join(dir, "pwned.txt")
  // Both entry shapes: the parsed one, and gatherDiff called directly with a
  // hand-built range (it is exported, so it validates on its own account).
  const viaParse = await gatherDiff(dir, parseReviewArg(`$(touch "${marker}")`))
  expect(viaParse.rejected).toBeTruthy()
  expect(viaParse.failure).toBeUndefined()
  const direct = await gatherDiff(dir, { range: `$(touch "${marker}")` })
  expect(direct.rejected).toBeTruthy()
  expect(direct.failure).toBeUndefined()
  expect(existsSync(marker)).toBe(false)
}, 20_000)

test("runReview refuses an invalid range without git or the model", async () => {
  const dir = await gitFixture()
  const provider = new MockProvider([])
  const result = await runReview(
    dir,
    {
      provider: () => provider,
      model: () => "mock",
      system: () => "s",
      cwd: dir,
      sessionsDir: tempDir("bfly-review-j-"),
      makeRegistry: () => new ToolRegistry(),
    },
    parseReviewArg("`git push --force`"),
  )
  expect(result.rejected).toBeTruthy()
  expect(result.journalPath).toBeUndefined()
  expect(result.summary).toContain("revision")
  // no model call was made
  expect(provider.requests.length).toBe(0)
}, 20_000)

test("a legit range still reaches git and produces a diff", async () => {
  const dir = await gitFixture()
  writeFileSync(join(dir, "app.ts"), "export const v = 2\n")
  await runCommand("git add -A && git commit -qm second", { cwd: dir })
  const result = await gatherDiff(dir, parseReviewArg("HEAD~1"))
  expect(result.rejected).toBeUndefined()
  expect(result.empty).toBe(false)
  expect(result.diff).toContain("app.ts")
}, 20_000)
