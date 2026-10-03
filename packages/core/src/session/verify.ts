import { resolveToolName } from "../tool/repair"
import type { SessionEvent } from "./events"


/** Commands that count as verification (tests, builds, type checks, linters). */
const CHECK_COMMAND =
  /\b(test|tests|pytest|jest|vitest|mocha|tsc|typecheck|lint|eslint|biome|ruff|mypy|pyright|clippy|cargo (test|check|build)|go (test|build|vet)|npm (run )?(test|build)|pnpm (run )?(test|build)|yarn (test|build)|bun (run )?(test|build)|make|gradle|mvn|dotnet (test|build))\b/

/** Paths that look like tests — edits to them deserve a second look. */
const TEST_PATH =
  /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py)$|(^|[\\/])test_[^\\/]*\.py$/i

export interface TurnVerification {
  /** Files the edit tool changed successfully this turn, in order. */
  edited: string[]
  /** Outcome of the last check that ran after the last edit. */
  checks: "passed" | "failed" | "none"
  /** The edited files that look like tests. */
  testsEdited: string[]
}

/** Fold the latest user turn (synthetic auto-continue nudges included). */
export function verifyLatestTurn(events: SessionEvent[]): TurnVerification {
  let start = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === "message.user" && event.synthetic !== true) {
      start = i
      break
    }
  }
  const calls = new Map<string, { tool: string; input: unknown }>()
  const edited: string[] = []
  let checks: TurnVerification["checks"] = "none"
  for (const event of events.slice(start)) {
    if (event.type === "tool.call") {
      calls.set(event.callId, {
        tool: resolveToolName(event.name, ["edit", "bash"]) ?? event.name,
        input: event.input,
      })
      continue
    }
    if (event.type !== "tool.result") continue
    const call = calls.get(event.callId)
    if (!call) continue
    const input = call.input as { file_path?: unknown; command?: unknown } | null
    if (call.tool === "edit" && !event.isError && typeof input?.file_path === "string") {
      if (!edited.includes(input.file_path)) edited.push(input.file_path)
      checks = "none" // a later edit invalidates earlier checks
    } else if (call.tool === "bash" && typeof input?.command === "string") {
      if (CHECK_COMMAND.test(input.command)) checks = event.isError ? "failed" : "passed"
    }
  }
  return { edited, checks, testsEdited: edited.filter((path) => TEST_PATH.test(path)) }
}

/** One ASCII line for the user, or "" when the turn edited nothing. */
export function describeVerification(v: TurnVerification): string {
  if (v.edited.length === 0) return ""
  const files = `${v.edited.length} file${v.edited.length === 1 ? "" : "s"} edited`
  const state =
    v.checks === "passed"
      ? "checks passed after the last edit"
      : v.checks === "failed"
        ? "the last check after the edits FAILED"
        : "no test/build/lint ran after the last edit (unverified)"
  const tests =
    v.testsEdited.length > 0 && v.testsEdited.length < v.edited.length
      ? ` - test files changed too (${v.testsEdited.slice(0, 3).join(", ")}${v.testsEdited.length > 3 ? ", ..." : ""}): check they were not weakened`
      : ""
  return `verify: ${files} - ${state}${tests}`
}
