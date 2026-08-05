import { statSync } from "node:fs"
import { ButterflyConfig, loadRawConfig } from "../config/config"
import { parseModelRef, presetEnvKey } from "../provider/hub"
import { HOOK_EVENTS } from "../session/hooks"
import { SessionJournal } from "../session/journal"
import { estimateTokens } from "./tokens"


export interface DoctorPrefixBreakdown {
  systemTokens: number
  memoryTokens: number
  skillsTokens: number
  graphSkeletonTokens: number
  graphAvailable: boolean
}

export interface DoctorJournalInfo {
  path?: string
  events: number
  bytes: number
  prunedEvents: number
  prunedCalls: number
  compactions: number
}

export interface DoctorMcpServer {
  name: string
  eagerTokens: number
  indexTokens: number
  savedTokens: number
}

export type DoctorLintKind =
  | "unknown-key"
  | "dead-hook"
  | "unknown-model"
  | "missing-provider-key"
  | "config-error"
  | "catalog-stale"

export interface DoctorLintIssue {
  kind: DoctorLintKind
  message: string
}

export interface DoctorReport {
  prefix: DoctorPrefixBreakdown
  journal: DoctorJournalInfo
  mcp: DoctorMcpServer[]
  mcpConfigured: string[]
  configLint: DoctorLintIssue[]
}

export interface DoctorCatalog {
  lookup(providerId: string, modelId: string): unknown
}

/** Structural subset of McpHub. */
export interface DoctorMcpHub {
  serverTokenSavings(): { name: string; eagerTokens: number; indexTokens: number }[]
}

export interface DoctorDeps {
  cwd: string
  home: string
  env?: Record<string, string | undefined>
  system: string
  memoryText: string
  skillsIndexText: string
  graphSkeletonText?: string
  /** False when the caller knows the graph index was never built. Defaults to true. */
  graphAvailable?: boolean
  journalPath?: string
  catalog?: DoctorCatalog
  catalogStatus?: "fresh" | "stale" | "missing"
  mcpHub?: DoctorMcpHub
  mcpConfiguredNames?: string[]
}

const SHELL_BUILTINS = new Set([
  "cd",
  "echo",
  "exit",
  "true",
  "false",
  "test",
  "pwd",
  "export",
  "set",
  "source",
  ".",
  ":",
])

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const UNVERIFIABLE_PREFIXES = ["(", "{", "!", "'", '"', "$", "`"]

/** The actual command word a hook's shell line starts with, skipping env assignments. */
function commandWord(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/)
  let i = 0
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i] ?? "")) i += 1
  return tokens[i]
}

function commandResolves(token: string): boolean {
  if (SHELL_BUILTINS.has(token)) return true
  if (token.includes("/") || token.includes("\\")) return true
  if (UNVERIFIABLE_PREFIXES.some((prefix) => token.startsWith(prefix))) return true
  try {
    return Bun.which(token) !== null
  } catch {
    return true
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function rawHooksArray(raw: unknown): Record<string, unknown>[] {
  if (!isPlainObject(raw)) return []
  const hooks = raw.hooks
  if (!Array.isArray(hooks)) return []
  return hooks.filter(isPlainObject)
}

function journalInfo(path: string | undefined): DoctorJournalInfo {
  const empty = { events: 0, bytes: 0, prunedEvents: 0, prunedCalls: 0, compactions: 0 }
  if (!path) return empty
  try {
    const { events } = SessionJournal.replay(path)
    let prunedEvents = 0
    let prunedCalls = 0
    let compactions = 0
    for (const event of events) {
      if (event.type === "tool.pruned") {
        prunedEvents += 1
        prunedCalls += event.callIds.length
      } else if (event.type === "session.compacted") {
        compactions += 1
      }
    }
    return {
      path,
      events: events.length,
      bytes: statSync(path).size,
      prunedEvents,
      prunedCalls,
      compactions,
    }
  } catch {
    return { path, ...empty }
  }
}

function lintConfig(deps: DoctorDeps): DoctorLintIssue[] {
  const issues: DoctorLintIssue[] = []
  const env = deps.env ?? process.env
  let raw: unknown
  try {
    raw = loadRawConfig({ cwd: deps.cwd, home: deps.home, env })
  } catch (error) {
    issues.push({
      kind: "config-error",
      message: `butterfly.jsonc failed to read: ${error instanceof Error ? error.message : String(error)}`,
    })
    return issues
  }

  const strict = ButterflyConfig.strict().safeParse(raw)
  if (!strict.success) {
    for (const issue of strict.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          issues.push({
            kind: "unknown-key",
            message: `unknown config key "${key}" in butterfly.jsonc`,
          })
        }
      }
    }
  }

  const parsed = ButterflyConfig.safeParse(raw)
  const config: ButterflyConfig = parsed.success ? parsed.data : {}

  for (const rawHook of rawHooksArray(raw)) {
    const event = rawHook.event
    if (typeof event === "string" && !(HOOK_EVENTS as readonly string[]).includes(event)) {
      issues.push({
        kind: "dead-hook",
        message: `hook has unknown event "${event}" — expected one of ${HOOK_EVENTS.join(", ")}`,
      })
    }
  }
  for (const hook of config.hooks ?? []) {
    if (hook.enabled === false) continue
    const word = commandWord(hook.command)
    if (word !== undefined && !commandResolves(word)) {
      issues.push({
        kind: "dead-hook",
        message: `hook command not found on PATH: "${word}" (${hook.event}${hook.match ? ` match=${hook.match}` : ""})`,
      })
    }
  }

  const refs: [string, string | undefined][] = [
    ["model", config.model],
    ["small_model", config.small_model],
  ]
  const catalogUsable = deps.catalogStatus !== "missing"
  let catalogNoted = false
  for (const [label, ref] of refs) {
    if (!ref) continue
    if (deps.catalogStatus && deps.catalogStatus !== "fresh" && !catalogNoted) {
      catalogNoted = true
      issues.push({
        kind: "catalog-stale",
        message:
          deps.catalogStatus === "missing"
            ? "no local models.dev cache yet — model-id checks skipped (run 'butterfly run' or open the TUI once online to build it; doctor never fetches)"
            : "the local models.dev cache is stale — model-id checks below may be out of date (doctor never fetches; refresh it via 'butterfly run' or the TUI)",
      })
    }
    let providerId: string
    let modelId: string
    try {
      ;({ providerId, modelId } = parseModelRef(ref))
    } catch {
      issues.push({
        kind: "unknown-model",
        message: `${label} "${ref}" is not a valid "provider/model" reference`,
      })
      continue
    }
    if (catalogUsable && deps.catalog && deps.catalog.lookup(providerId, modelId) === undefined) {
      issues.push({
        kind: "unknown-model",
        message: `${label} "${ref}" not found in the models.dev catalog — verify the id (the local cache may be stale)`,
      })
    }
    const envKey = presetEnvKey(providerId)
    if (envKey) {
      const hasOverrideKey = Boolean(config.providers?.[providerId]?.apiKey)
      const hasEnvKey = Boolean(env[envKey])
      if (!hasOverrideKey && !hasEnvKey) {
        issues.push({
          kind: "missing-provider-key",
          message: `${label} "${ref}" needs ${envKey} (env) or providers.${providerId}.apiKey — neither is set`,
        })
      }
    }
  }

  return issues
}

export function doctor(deps: DoctorDeps): DoctorReport {
  const savings = deps.mcpHub?.serverTokenSavings() ?? []
  const measuredNames = new Set(savings.map((s) => s.name))
  return {
    prefix: {
      systemTokens: estimateTokens(deps.system),
      memoryTokens: estimateTokens(deps.memoryText),
      skillsTokens: estimateTokens(deps.skillsIndexText),
      graphSkeletonTokens: estimateTokens(deps.graphSkeletonText ?? ""),
      graphAvailable: deps.graphAvailable ?? true,
    },
    journal: journalInfo(deps.journalPath),
    mcp: savings.map((s) => ({ ...s, savedTokens: s.eagerTokens - s.indexTokens })),
    mcpConfigured: (deps.mcpConfiguredNames ?? []).filter((name) => !measuredNames.has(name)),
    configLint: lintConfig(deps),
  }
}

export interface RenderDoctorOptions {
  bar?: (tokens: number) => string
}

export function renderDoctorReport(report: DoctorReport, opts: RenderDoctorOptions = {}): string {
  const bar = opts.bar ?? (() => "")
  const lines: string[] = [
    "doctor — context audit:",
    "",
    "prefix breakdown:",
    `  system prompt   ~${report.prefix.systemTokens.toLocaleString()} tok${bar(report.prefix.systemTokens)}`,
    `  memory          ~${report.prefix.memoryTokens.toLocaleString()} tok${bar(report.prefix.memoryTokens)}`,
    `  skills index    ~${report.prefix.skillsTokens.toLocaleString()} tok${bar(report.prefix.skillsTokens)}`,
    report.prefix.graphAvailable
      ? `  graph skeleton  ~${report.prefix.graphSkeletonTokens.toLocaleString()} tok${bar(report.prefix.graphSkeletonTokens)}`
      : "  graph skeleton  not initialized (run `butterfly run` once, or open the TUI, to build the index)",
    "",
    "journal:",
    `  path            ${report.journal.path ?? "(no session yet)"}`,
    `  events          ${report.journal.events.toLocaleString()}`,
    `  bytes           ${report.journal.bytes.toLocaleString()}`,
    `  pruned          ${report.journal.prunedEvents} event(s) · ${report.journal.prunedCalls} tool result(s)`,
    `  compactions     ${report.journal.compactions}`,
    "",
    "mcp lazy disclosure:",
  ]
  if (report.mcp.length === 0 && report.mcpConfigured.length === 0) {
    lines.push("  no MCP servers connected")
  } else {
    for (const server of report.mcp) {
      lines.push(
        `  ${server.name}  index ${server.indexTokens} tok vs eager ${server.eagerTokens} tok — saving ~${server.savedTokens.toLocaleString()} tok/turn`,
      )
    }
    for (const name of report.mcpConfigured) {
      lines.push(`  ${name}  configured, not verified (connect via TUI/run to measure savings)`)
    }
  }
  lines.push("")
  lines.push(
    `config lint: ${report.configLint.length === 0 ? "clean" : `${report.configLint.length} issue(s)`}`,
  )
  for (const issue of report.configLint) lines.push(`  [${issue.kind}] ${issue.message}`)
  return lines.join("\n")
}
