import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ProviderPort } from "../provider/port"
import { runCommand } from "../tool/shell"
import { type GitFailure, gatherDiff } from "./review"
import { GIT_TIMEOUT_MS, isGitRepo } from "./snapshot"


const DEFAULT_LOG_SUBJECT_COUNT = 20

export const COMMIT_MSG_PROMPT =
  'Generate a single git commit message for the staged diff below, styled to match the project\'s recent commit history (shown as "recent subjects", if any). Output ONLY the commit message text — a one-line subject (<=72 chars), optionally followed by a blank line and a short body. No markdown fences, no explanation, no surrounding quotes.'

export interface RecentLogOptions {
  count?: number
}

export async function recentLogSubjects(
  cwd: string,
  opts: RecentLogOptions = {},
): Promise<string[]> {
  if (!isGitRepo(cwd)) return []
  const count = opts.count ?? DEFAULT_LOG_SUBJECT_COUNT
  const result = await runCommand(`git log -${count} --pretty=format:%s`, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (result.exitCode !== 0 || result.timedOut) return []
  return result.stdout.split("\n").filter((line) => line.trim() !== "")
}

export function buildCommitMessagePrompt(diff: string, recentSubjects: string[]): string {
  const style =
    recentSubjects.length > 0
      ? `recent subjects (match this style):\n${recentSubjects.map((s) => `  ${s}`).join("\n")}\n\n`
      : ""
  return `${style}staged diff:\n\`\`\`diff\n${diff}\n\`\`\``
}

export interface GenerateCommitMessageOptions {
  cwd: string
  provider: ProviderPort
  model: string
  logOptions?: RecentLogOptions
}

export interface GenerateCommitMessageResult {
  message: string
  diffChars: number
  /** True when the index is empty — the caller should offer to stage first. */
  nothingStaged: boolean
  failure?: GitFailure
}

export async function generateCommitMessage(
  opts: GenerateCommitMessageOptions,
): Promise<GenerateCommitMessageResult> {
  const gathered = await gatherDiff(opts.cwd, { staged: true })
  if (gathered.failure) {
    return { message: "", diffChars: 0, nothingStaged: false, failure: gathered.failure }
  }
  if (gathered.empty) {
    return { message: "", diffChars: 0, nothingStaged: true }
  }
  const subjects = await recentLogSubjects(opts.cwd, opts.logOptions)

  let message = ""
  for await (const event of opts.provider.streamTurn({
    model: opts.model,
    messages: [
      { role: "system", content: COMMIT_MSG_PROMPT },
      { role: "user", content: buildCommitMessagePrompt(gathered.diff, subjects) },
    ],
  })) {
    if (event.type === "text-delta") message += event.text
    else if (event.type === "error")
      throw new Error(`Commit message generation failed: ${event.message}`)
  }
  return { message: message.trim(), diffChars: gathered.diff.length, nothingStaged: false }
}

export async function stageAllTracked(cwd: string): Promise<boolean> {
  if (!isGitRepo(cwd)) return false
  const result = await runCommand("git add -u", { cwd, timeoutMs: GIT_TIMEOUT_MS })
  return result.exitCode === 0 && !result.timedOut
}

export function writeCommitMessageFile(cwd: string, message: string): string {
  const path = join(cwd, ".butterfly", "COMMIT_EDITMSG")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, message)
  return path
}
