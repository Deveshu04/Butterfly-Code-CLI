import { settle } from "../tool/settle"
import { type RunCommandResult, runCommand } from "../tool/shell"
import {
  runSubagentTurn,
  type SubagentTurnOptions,
  type SubagentTurnResult,
} from "../tool/tools/task"
import { now, type SessionEvent } from "./events"
import { GIT_TIMEOUT_MS, isGitRepo } from "./snapshot"


export const REVIEW_DIFF_MAX_CHARS = 20_000

export interface GatherDiffOptions {
  range?: string
  /** Only the index (`git diff --staged`). Ignored when `range` is set. */
  staged?: boolean
  rejected?: string
}

export const REVISION_MAX_CHARS = 200

const REVISION_MAX_TOKENS = 3

const REVISION_TOKEN = /^[A-Za-z0-9._/:@^~{}-]+$/

export type RevisionVerdict = { ok: true; range: string } | { ok: false; reason: string }

export function validateRevisionRange(raw: string): RevisionVerdict {
  const range = raw.trim()
  const refuse = (why: string): RevisionVerdict => ({
    ok: false,
    reason: `${why} — /review takes a git revision (e.g. HEAD~3, main..feature, v1.2.3, --staged), not a shell expression`,
  })
  if (range === "") return refuse("empty revision")
  if (range.length > REVISION_MAX_CHARS) {
    return refuse(`revision argument longer than ${REVISION_MAX_CHARS} characters`)
  }
  const tokens = range.split(/\s+/)
  if (tokens.length > REVISION_MAX_TOKENS) return refuse("too many revision arguments")
  for (const token of tokens) {
    // A leading "-" would smuggle git-diff options (--output= writes files).
    if (token.startsWith("-")) return refuse(`"${token}" looks like an option, not a revision`)
    if (token.startsWith("~")) return refuse(`"${token}" starts with a shell tilde expansion`)
    if (!REVISION_TOKEN.test(token)) return refuse(`"${token}" is not valid git revision syntax`)
  }
  return { ok: true, range: tokens.join(" ") }
}

/** A git spawn that did not succeed — never silently equal to "clean tree". */
export interface GitFailure {
  command: string
  exitCode: number
  stderr: string
  timedOut: boolean
}

export const GIT_STDERR_MAX_CHARS = 400

export interface GatheredDiff {
  diff: string
  truncated: boolean
  /** True when there is nothing to review: no repo, or a clean tree/index. */
  empty: boolean
  failure?: GitFailure
  rejected?: string
}

function failureOf(command: string, result: RunCommandResult): GitFailure | undefined {
  if (!result.timedOut && result.exitCode === 0) return undefined
  const stderr = result.stderr
    .trim()
    .split("\n")
    .slice(0, 3)
    .join("\n")
    .slice(0, GIT_STDERR_MAX_CHARS)
  return { command, exitCode: result.exitCode, stderr, timedOut: result.timedOut }
}

/** One-line, user-facing reason: what ran, how it failed, what git said. */
export function describeGitFailure(failure: GitFailure): string {
  const reason = failure.timedOut
    ? `timed out after ${GIT_TIMEOUT_MS}ms`
    : `exited ${failure.exitCode}`
  return failure.stderr === ""
    ? `\`${failure.command}\` ${reason}`
    : `\`${failure.command}\` ${reason} — ${failure.stderr}`
}

export async function gatherDiff(cwd: string, opts: GatherDiffOptions = {}): Promise<GatheredDiff> {
  if (opts.rejected) return { diff: "", truncated: false, empty: true, rejected: opts.rejected }
  const verdict = opts.range === undefined ? undefined : validateRevisionRange(opts.range)
  if (verdict && !verdict.ok) {
    return { diff: "", truncated: false, empty: true, rejected: verdict.reason }
  }
  if (!isGitRepo(cwd)) return { diff: "", truncated: false, empty: true }

  let raw: string
  if (verdict?.ok) {
    const command = `git diff ${verdict.range}`
    const result = await runCommand(command, { cwd, timeoutMs: GIT_TIMEOUT_MS })
    const failure = failureOf(command, result)
    if (failure) return { diff: "", truncated: false, empty: true, failure }
    raw = result.stdout
  } else if (opts.staged) {
    const command = "git diff --staged"
    const result = await runCommand(command, { cwd, timeoutMs: GIT_TIMEOUT_MS })
    const failure = failureOf(command, result)
    if (failure) return { diff: "", truncated: false, empty: true, failure }
    raw = result.stdout
  } else {
    const [unstaged, staged] = await Promise.all([
      runCommand("git diff", { cwd, timeoutMs: GIT_TIMEOUT_MS }),
      runCommand("git diff --staged", { cwd, timeoutMs: GIT_TIMEOUT_MS }),
    ])
    const failure = failureOf("git diff", unstaged) ?? failureOf("git diff --staged", staged)
    if (failure) return { diff: "", truncated: false, empty: true, failure }
    const parts: string[] = []
    if (unstaged.stdout.trim() !== "") parts.push(`# unstaged changes\n${unstaged.stdout}`)
    if (staged.stdout.trim() !== "") parts.push(`# staged changes\n${staged.stdout}`)
    raw = parts.join("\n\n")
  }

  if (raw.trim() === "") return { diff: "", truncated: false, empty: true }
  const settled = settle(raw, { maxChars: REVIEW_DIFF_MAX_CHARS })
  return { diff: settled.text, truncated: settled.truncated, empty: false }
}

export function parseReviewArg(arg: string): GatherDiffOptions {
  const trimmed = arg.trim()
  if (trimmed === "") return {}
  if (trimmed === "--staged") return { staged: true }
  const verdict = validateRevisionRange(trimmed)
  return verdict.ok ? { range: verdict.range } : { rejected: verdict.reason }
}

export function describeReviewScope(opts: GatherDiffOptions): string {
  if (opts.range) return `git diff ${opts.range}`
  if (opts.staged) return "staged changes"
  return "unstaged + staged changes"
}

export const REVIEW_RUBRIC = `Review this diff. Cite the exact file:line for every issue you raise. Cover:
- correctness: logic errors, edge cases, off-by-one, null/undefined handling
- tests: missing coverage for new/changed behavior, weak or absent assertions
- security: injection, unsafe deserialization, secrets, path traversal, permission bypasses
- conventions: style/naming/structure inconsistent with the surrounding code

Be terse — skip sections with nothing to say. End with a one-line verdict: LGTM, MINOR ISSUES, or NEEDS WORK.`

export function buildReviewPrompt(diff: string): string {
  return `${REVIEW_RUBRIC}\n\n\`\`\`diff\n${diff}\n\`\`\``
}

export interface ReviewResult {
  summary: string
  /** Undefined when no subagent ran (nothing to review, or git failed). */
  journalPath?: string
  diffChars: number
  truncated: boolean
  /** Set when git failed — distinct from "nothing to review"; no model ran. */
  failure?: GitFailure
  /** Set when the revision argument was refused — nothing ran at all. */
  rejected?: string
}

export async function runReview(
  cwd: string,
  subagent: SubagentTurnOptions,
  diffOpts: GatherDiffOptions = {},
  signal?: AbortSignal,
): Promise<ReviewResult> {
  const gathered = await gatherDiff(cwd, diffOpts)
  if (gathered.rejected) {
    return {
      summary: gathered.rejected,
      diffChars: 0,
      truncated: false,
      rejected: gathered.rejected,
    }
  }
  if (gathered.failure) {
    return {
      summary: `git failed: ${describeGitFailure(gathered.failure)}`,
      diffChars: 0,
      truncated: false,
      failure: gathered.failure,
    }
  }
  if (gathered.empty) {
    return {
      summary:
        "nothing to review — no diff found (working tree and index both clean, or not a git repo).",
      diffChars: 0,
      truncated: false,
    }
  }
  const result: SubagentTurnResult = await runSubagentTurn(
    subagent,
    buildReviewPrompt(gathered.diff),
    signal,
  )
  return {
    summary: result.summary,
    journalPath: result.journalPath,
    diffChars: gathered.diff.length,
    truncated: gathered.truncated,
  }
}

export type ReviewEvent = Extract<SessionEvent, { type: "session.review" }>

/** Minimal journal seam — anything append-shaped (SessionJournal) fits. */
export interface ReviewJournalSink {
  append(event: SessionEvent): void
}

export function journalReview(
  journal: ReviewJournalSink,
  result: ReviewResult,
  scope?: string,
): ReviewEvent | undefined {
  if (!result.journalPath) return undefined
  const event: ReviewEvent = {
    time: now(),
    type: "session.review",
    summary: result.summary,
    ...(scope ? { scope } : {}),
    diffChars: result.diffChars,
    truncated: result.truncated,
    journalPath: result.journalPath,
  }
  journal.append(event)
  return event
}
