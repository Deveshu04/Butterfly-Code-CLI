export type PermissionDecision = "allow" | "ask" | "deny"

export type PermissionRules = Record<
  string,
  PermissionDecision | Record<string, PermissionDecision>
>

const SEVERITY: Record<PermissionDecision, number> = { deny: 2, ask: 1, allow: 0 }

export function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

export function resolvePermission(
  rules: PermissionRules,
  tool: string,
  target?: string,
): PermissionDecision {
  return resolvePermissionWithSource(rules, tool, target).decision
}

export function resolvePermissionWithSource(
  rules: PermissionRules,
  tool: string,
  target?: string,
): { decision: PermissionDecision; blanket: boolean } {
  const decision = resolveRaw(rules, tool, target)
  return {
    decision: decision.decision,
    blanket: decision.pattern === undefined || decision.pattern === "*",
  }
}

function resolveRaw(
  rules: PermissionRules,
  tool: string,
  target?: string,
): { decision: PermissionDecision; pattern?: string } {
  const entry = rules[tool]
  if (typeof entry === "string") return { decision: entry }

  if (entry) {
    const candidate = target ?? ""
    let best: { length: number; decision: PermissionDecision; pattern: string } | undefined
    for (const [pattern, decision] of Object.entries(entry)) {
      // Without a target only the blanket "*" entry can speak for the tool.
      if (target === undefined && pattern !== "*") continue
      if (!wildcardToRegex(pattern).test(candidate)) continue
      const better =
        !best ||
        pattern.length > best.length ||
        (pattern.length === best.length && SEVERITY[decision] > SEVERITY[best.decision])
      if (better) best = { length: pattern.length, decision, pattern }
    }
    if (best) return { decision: best.decision, pattern: best.pattern }
  }

  const root = rules["*"]
  if (typeof root === "string") return { decision: root }
  return { decision: "ask" }
}
