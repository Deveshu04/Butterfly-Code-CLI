import { dirname } from "node:path"
import { type PermissionDecision, type PermissionRules, wildcardToRegex } from "./tree"


const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/

function bashAllowPattern(command: string): string {
  let rest = command.trim()
  let sawEnvPrefix = false
  while (ENV_ASSIGNMENT.test(rest)) {
    rest = rest.replace(ENV_ASSIGNMENT, "")
    sawEnvPrefix = true
  }
  let word: string
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0] as string
    const close = rest.indexOf(quote, 1)
    word = close === -1 ? rest : rest.slice(0, close + 1)
  } else {
    const spaceIndex = rest.search(/\s/)
    word = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
  }
  return `${sawEnvPrefix ? "*" : ""}${word} *`
}

function directoryAllowPattern(filePath: string): string {
  const dir = dirname(filePath)
  if (dir === "." || dir === "") return filePath
  const sep = filePath.includes("\\") && !filePath.includes("/") ? "\\" : "/"
  return `${dir}${sep}**`
}

export function computeAllowPattern(tool: string, target: string | undefined): string {
  if (tool === "bash" && target !== undefined) return bashAllowPattern(target)
  if ((tool === "edit" || tool === "read") && target !== undefined) {
    return directoryAllowPattern(target)
  }
  if (target !== undefined) return target
  return "*"
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
  const pattern = computeAllowPattern(tool, target)
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
