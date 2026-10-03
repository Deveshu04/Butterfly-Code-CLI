import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { mergeAllowRule } from "../permission/quick-add"
import type { PermissionRules } from "../permission/tree"

const Decision = z.enum(["allow", "ask", "deny"])

export const ButterflyConfig = z.object({
  /** "provider/model", e.g. "openrouter/deepseek/deepseek-chat-v3". */
  model: z.string().optional(),
  small_model: z.string().optional(),
  /**
   * When small_model is unset, pick a cheap same-provider model from the
   * models.dev catalog for summarization-class work (compaction, memory
   * evolver, commit messages) instead of the main model. Default true.
   */
  auto_small_model: z.boolean().optional(),
  /**
   * Default model for task subagents (parallel fan-out, worktree workers).
   * Falls back to small_model, then the main model. The main model stays
   * the orchestrator and can opt a subtask into itself with model:"main".
   */
  subagent_model: z.string().optional(),
  providers: z
    .record(
      z.string(),
      z.object({
        baseURL: z.string().optional(),
        apiKey: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  permissions: z.record(z.string(), z.union([Decision, z.record(z.string(), Decision)])).optional(),
  gates: z.array(z.object({ name: z.string(), command: z.string() })).optional(),
  /** Default thinking-effort dial (overridable per session with /think). */
  reasoning: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  /** Hard dollar ceiling per turn (priced from models.dev). */
  maxSpendUSD: z.number().positive().optional(),
  retries: z.number().int().min(0).optional(),
  /**
   * Auto-continue nudges per turn when the model stops with todos it was
   * working still open, or its reply hit the output cap. Default 2; 0 off.
   */
  autoContinue: z.number().int().min(0).max(10).optional(),
  /**
   * Run provably read-only shell commands (`ls`, `git status`, `rg x | head`)
   * without asking when bash is a blanket "ask". Explicit permission
   * patterns always win. Default true; false asks for every command.
   */
  autoApproveReadOnly: z.boolean().optional(),
  memory: z
    .object({
      /** Post-turn memory review. Default true. */
      autoReview: z.boolean().optional(),
      /** Let the reviewer draft + reinforce skills. Default true. */
      autoSkills: z.boolean().optional(),
      /** Stage agent memory writes as .pending files for human approval. Default false. */
      approval: z.boolean().optional(),
    })
    .optional(),
  notifications: z.boolean().optional(),
  theme: z.string().optional(),
  mcp: z
    .record(
      z.string(),
      z.object({
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
  /** Lifecycle hooks; pre.tool hooks with non-zero exit BLOCK the call. */
  hooks: z
    .array(
      z.object({
        event: z.enum(["session.start", "turn.start", "pre.tool", "post.tool", "turn.end"]),
        match: z.string().optional(),
        command: z.string(),
        feedback: z.boolean().optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .optional(),
  web: z
    .object({
      /** Pin a search backend; otherwise the first configured key wins, then ddg. */
      provider: z.enum(["tavily", "brave", "exa", "openrouter", "model", "ddg"]).optional(),
      tavily: z.object({ apiKey: z.string() }).optional(),
      brave: z.object({ apiKey: z.string() }).optional(),
      exa: z.object({ apiKey: z.string() }).optional(),
      /** Model for the nested provider-native-search fallback (not yet implemented). */
      searchModel: z.string().optional(),
      /** Optional r.jina.ai key; setting one also opts op=fetch into that backend. */
      jinaKey: z.string().optional(),
      allowJina: z.boolean().optional(),
      /** Default results per op=search when the model does not pass maxResults. */
      maxResults: z.number().int().min(1).max(10).optional(),
      /** Model-visible cap on a fetched page (the full text still rides `meta`). */
      maxFetchChars: z.number().int().positive().optional(),
      /** Set false to hard-disable the keyless DuckDuckGo-lite search fallback. */
      allowDuckDuckGo: z.boolean().optional(),
    })
    .optional(),
})
export type ButterflyConfig = z.infer<typeof ButterflyConfig>

/** JSONC: strips // and block comments (string-aware) and trailing commas. */
export function parseJsonc(text: string): unknown {
  // Pass 1: remove comments, tracking JSON string state.
  let cleaned = ""
  let inString = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      cleaned += ch
      if (ch === "\\") {
        cleaned += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      cleaned += ch
      i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    cleaned += ch
    i += 1
  }

  // Pass 2: drop trailing commas, again string-aware.
  let result = ""
  inString = false
  i = 0
  while (i < cleaned.length) {
    const ch = cleaned[i]
    if (inString) {
      result += ch
      if (ch === "\\") {
        result += cleaned[i + 1] ?? ""
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      result += ch
      i += 1
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < cleaned.length && /\s/.test(cleaned[j] ?? "")) j += 1
      if (cleaned[j] === "}" || cleaned[j] === "]") {
        i += 1
        continue
      }
    }
    result += ch
    i += 1
  }

  return JSON.parse(result)
}

/** Replace "{env:VAR}" placeholders in every string value. */
export function substituteEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, name: string) => env[name] ?? "")
  }
  if (Array.isArray(value)) return value.map((item) => substituteEnv(item, env))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteEnv(v, env)]),
    )
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export interface LoadConfigOptions {
  cwd: string
  home?: string
  env?: Record<string, string | undefined>
}

function readJsoncFile(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  return parseJsonc(text)
}

function mergeSources(opts: LoadConfigOptions): unknown {
  const home = opts.home ?? process.env["USERPROFILE"] ?? process.env["HOME"] ?? ""
  const env = opts.env ?? process.env
  const sources = [
    readJsoncFile(join(home, ".config", "butterfly", "butterfly.jsonc")),
    readJsoncFile(join(opts.cwd, "butterfly.jsonc")),
    readJsoncFile(join(opts.cwd, ".butterfly", "butterfly.jsonc")),
  ].filter((source) => source !== undefined)

  let merged: unknown = {}
  for (const source of sources) merged = mergeConfigs(merged, source)
  return substituteEnv(merged, env)
}

export function loadConfig(opts: LoadConfigOptions): ButterflyConfig {
  return ButterflyConfig.parse(mergeSources(opts))
}

export function loadRawConfig(opts: LoadConfigOptions): unknown {
  return mergeSources(opts)
}

export function saveGlobalConfig(patch: Partial<ButterflyConfig>, opts: { home: string }): string {
  const path = join(opts.home, ".config", "butterfly", "butterfly.jsonc")
  const existing = readJsoncFile(path) ?? {}
  const merged = ButterflyConfig.parse(mergeConfigs(existing, patch))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`)
  return path
}


function containsComments(text: string): boolean {
  let inString = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      i += 1
      continue
    }
    if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) return true
    i += 1
  }
  return false
}

export interface ConfigHooksSource {
  /** Absolute path to the config file whose `hooks` array is currently in effect. */
  path: string
  scope: "global" | "project"
  /** Raw (pre-validation) hooks array exactly as read from that file. */
  hooks: unknown[]
}

export function locateHooksSource(opts: LoadConfigOptions): ConfigHooksSource | undefined {
  const home = opts.home ?? process.env["USERPROFILE"] ?? process.env["HOME"] ?? ""
  const candidates: { path: string; scope: "global" | "project" }[] = [
    { path: join(opts.cwd, ".butterfly", "butterfly.jsonc"), scope: "project" },
    { path: join(opts.cwd, "butterfly.jsonc"), scope: "project" },
    { path: join(home, ".config", "butterfly", "butterfly.jsonc"), scope: "global" },
  ]
  for (const candidate of candidates) {
    const raw = readJsoncFile(candidate.path)
    if (isPlainObject(raw) && Array.isArray(raw.hooks)) {
      return { path: candidate.path, scope: candidate.scope, hooks: raw.hooks }
    }
  }
  return undefined
}

export interface HookToggleResult {
  ok: boolean
  path: string
  scope: "global" | "project"
  snippet?: string
}

export function setHookEnabled(
  index: number,
  enabled: boolean,
  opts: LoadConfigOptions,
): HookToggleResult {
  const source = locateHooksSource(opts)
  if (!source) throw new Error("no config file defines a hooks[] array")
  const hook = source.hooks[index]
  if (!isPlainObject(hook)) {
    throw new Error(`hooks[${index}] is not an object in ${source.path}`)
  }
  const text = readFileSync(source.path, "utf8")
  if (containsComments(text)) {
    const event = typeof hook.event === "string" ? hook.event : "?"
    const command = typeof hook.command === "string" ? hook.command : "?"
    const snippet = `{ "event": "${event}", "command": ${JSON.stringify(command)}, "enabled": ${enabled} }`
    return { ok: false, path: source.path, scope: source.scope, snippet }
  }
  const raw = parseJsonc(text)
  if (!isPlainObject(raw) || !Array.isArray(raw.hooks)) {
    throw new Error(`${source.path} no longer defines hooks[]`)
  }
  const hooksArr: unknown[] = raw.hooks
  const target = hooksArr[index]
  if (!isPlainObject(target)) {
    throw new Error(`hooks[${index}] is not an object in ${source.path}`)
  }
  hooksArr[index] = { ...target, enabled }
  writeFileSync(source.path, `${JSON.stringify(raw, null, 2)}\n`)
  return { ok: true, path: source.path, scope: source.scope }
}


export interface PermissionWriteResult {
  ok: boolean
  path: string
  snippet?: string
}

export function setPermissionRule(
  tool: string,
  pattern: string,
  opts: LoadConfigOptions,
): PermissionWriteResult {
  const path = join(opts.cwd, "butterfly.jsonc")
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    text = ""
  }
  if (text !== "" && containsComments(text)) {
    const snippet = `"permissions": { "${tool}": { "${pattern}": "allow" } }`
    return { ok: false, path, snippet }
  }
  const raw = text === "" ? {} : parseJsonc(text)
  const base: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {}
  const currentPermissions: PermissionRules = isPlainObject(base["permissions"])
    ? (base["permissions"] as PermissionRules)
    : {}
  base["permissions"] = mergeAllowRule(currentPermissions, tool, pattern)
  ButterflyConfig.parse(base)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(base, null, 2)}\n`)
  return { ok: true, path }
}

/** Deep-merge configs; later sources win on scalars, objects merge. */
export function mergeConfigs(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
      merged[key] = key in merged ? mergeConfigs(merged[key], value) : value
    }
    return merged
  }
  return override === undefined ? base : override
}
