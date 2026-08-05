export type PermissionDecision = "allow" | "ask" | "deny"

export type PermissionRules = Record<
  string,
  PermissionDecision | Record<string, PermissionDecision>
>

const SEVERITY: Record<PermissionDecision, number> = { deny: 2, ask: 1, allow: 0 }

function wildcardToRegex(pattern: string): RegExp {
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
  const entry = rules[tool]
  if (typeof entry === "string") return entry

  if (entry) {
    const candidate = target ?? ""
    let best: { length: number; decision: PermissionDecision } | undefined
    for (const [pattern, decision] of Object.entries(entry)) {
      // Without a target only the blanket "*" entry can speak for the tool.
      if (target === undefined && pattern !== "*") continue
      if (!wildcardToRegex(pattern).test(candidate)) continue
      const better =
        !best ||
        pattern.length > best.length ||
        (pattern.length === best.length && SEVERITY[decision] > SEVERITY[best.decision])
      if (better) best = { length: pattern.length, decision }
    }
    if (best) return best.decision
  }

  const root = rules["*"]
  if (typeof root === "string") return root
  return "ask"
}
