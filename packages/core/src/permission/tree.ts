export type PermissionDecision = "allow" | "ask" | "deny"

/**
 * Rules shape:
 *   { "*": "ask", "bash": { "git *": "allow" }, "edit": { ".env*": "deny" } }
 * A tool entry is either a blanket decision or a map of wildcard patterns
 * ("*" any sequence, "?" one char) over the tool's target (command / path).
 * Resolution: longest matching pattern wins; on ties deny > ask > allow;
 * unmatched targets fall through to the root "*" default, then to "ask".
 */
export type PermissionRules = Record<
  string,
  PermissionDecision | Record<string, PermissionDecision>
>

const SEVERITY: Record<PermissionDecision, number> = { deny: 2, ask: 1, allow: 0 }

/** Exported for quick-add's overlap heuristic. */
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

/**
 * Like resolvePermission, plus whether the decision came from a blanket rule
 * (plain string entry, "*" pattern, or root default). Conveniences such as
 * read-only auto-approval may only soften blanket asks.
 */
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
