import { dirname } from "node:path"
import { type PermissionDecision, type PermissionRules, wildcardToRegex } from "./tree"


const ENV_ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Glob metacharacters that are live (and un-escapable) in wildcardToRegex. */
const GLOB_METACHARACTER = /[*?]/

function scanToken(source: string, from: number): { end: number; unterminated: boolean } {
  let quote: string | undefined
  for (let i = from; i < source.length; i++) {
    const ch = source[i] as string
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) return { end: i, unterminated: false }
  }
  return { end: source.length, unterminated: quote !== undefined }
}

function bashCommandWord(command: string): { word?: string; problem?: string } {
  let rest = command.trim()
  if (rest === "") return { problem: "the command is empty" }
  for (;;) {
    const name = rest.match(ENV_ASSIGNMENT_NAME)
    if (!name) break
    const value = scanToken(rest, name[0].length)
    if (value.unterminated) return { problem: "the command has unbalanced quoting" }
    rest = rest.slice(value.end).trimStart()
    if (rest === "") return { problem: "the command is only environment-variable assignments" }
  }
  const token = scanToken(rest, 0)
  if (token.unterminated) return { problem: "the command has unbalanced quoting" }
  return { word: rest.slice(0, token.end) }
}

interface AllowPatternParts {
  /** The rule pattern itself (display-safe even when `problem` is set). */
  pattern: string
  literal: string
  /** Set when the target could not be narrowed confidently at all. */
  problem?: string
}

function computeAllowPatternParts(tool: string, target: string | undefined): AllowPatternParts {
  if (tool === "bash" && target !== undefined) {
    const { word, problem } = bashCommandWord(target)
    if (word === undefined) {
      return { pattern: target.trim(), literal: "", problem: problem ?? "the command is empty" }
    }
    return { pattern: `${word} *`, literal: word }
  }
  if ((tool === "edit" || tool === "read") && target !== undefined) {
    const dir = dirname(target)
    if (dir === "." || dir === "") return { pattern: target, literal: target }
    const sep = target.includes("\\") && !target.includes("/") ? "\\" : "/"
    return { pattern: `${dir}${sep}**`, literal: dir }
  }
  if (target !== undefined) return { pattern: target, literal: target }
  return { pattern: "*", literal: "" }
}

export function computeAllowPattern(tool: string, target: string | undefined): string {
  return computeAllowPatternParts(tool, target).pattern
}

function stripWildcards(pattern: string): string {
  return pattern.replace(/[*?]/g, "")
}

function patternsOverlap(a: string, b: string): boolean {
  const literalA = stripWildcards(a)
  const literalB = stripWildcards(b)
  if (literalA !== "" && wildcardToRegex(b).test(literalA)) return true
  if (literalB !== "" && wildcardToRegex(a).test(literalB)) return true
  return false
}

export function mergeAllowRule(
  rules: PermissionRules,
  tool: string,
  pattern: string,
): PermissionRules {
  const existing = rules[tool]
  const map: Record<string, PermissionDecision> =
    typeof existing === "string" ? { "*": existing } : { ...(existing ?? {}) }
  return { ...rules, [tool]: { ...map, [pattern]: "allow" } }
}

export interface QuickAddPlan {
  ok: boolean
  tool: string
  pattern: string
  rules?: PermissionRules
  reason?: string
}

export function planQuickAdd(
  rules: PermissionRules,
  tool: string,
  target: string | undefined,
): QuickAddPlan {
  const { pattern, literal, problem } = computeAllowPatternParts(tool, target)
  if (problem !== undefined) {
    return { ok: false, tool, pattern, reason: `cannot narrow this call to a rule: ${problem}` }
  }
  if (GLOB_METACHARACTER.test(literal)) {
    return {
      ok: false,
      tool,
      pattern,
      reason:
        `"${literal}" contains a glob wildcard and the rule language has no ` +
        `escape syntax, so "${pattern}" would match more than this call`,
    }
  }
  const existing = rules[tool]
  if (existing === "deny") {
    return { ok: false, tool, pattern, reason: `"${tool}" is denied entirely by policy` }
  }
  const map: Record<string, PermissionDecision> =
    typeof existing === "string" ? {} : (existing ?? {})
  for (const [existingPattern, decision] of Object.entries(map)) {
    if (decision !== "deny") continue
    if (existingPattern === pattern) {
      return {
        ok: false,
        tool,
        pattern,
        reason: `"${tool}: ${existingPattern}" is already denied by policy`,
      }
    }
    if (pattern.length > existingPattern.length && patternsOverlap(pattern, existingPattern)) {
      return {
        ok: false,
        tool,
        pattern,
        reason: `would widen the existing deny rule "${tool}: ${existingPattern}"`,
      }
    }
  }
  return { ok: true, tool, pattern, rules: mergeAllowRule(rules, tool, pattern) }
}
