/**
 * Hand-written ACP wire types and runtime validators for the subset of the
 * Agent Client Protocol that `butterfly acp` implements.
 * Spec: https://agentclientprotocol.com
 *
 * Not zod: packages/cli does not depend on zod, and these validators are
 * enough to reject malformed params with a proper JSON-RPC error.
 */

/** A single integer identifying a MAJOR protocol version. */
export const PROTOCOL_VERSION = 1

export interface ValidationOk<T> {
  ok: true
  data: T
}
export interface ValidationErr {
  ok: false
  message: string
}
export type ValidationResult<T> = ValidationOk<T> | ValidationErr

function ok<T>(data: T): ValidationOk<T> {
  return { ok: true, data }
}
function err(message: string): ValidationErr {
  return { ok: false, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// initialize

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean }
  terminal?: boolean
}

export interface InitializeParams {
  protocolVersion: number
  clientCapabilities?: ClientCapabilities
  clientInfo?: { name: string; title?: string; version?: string }
}

export function parseInitializeParams(raw: unknown): ValidationResult<InitializeParams> {
  if (!isRecord(raw)) return err("params must be an object")
  if (typeof raw.protocolVersion !== "number") return err("protocolVersion must be a number")
  const result: InitializeParams = { protocolVersion: raw.protocolVersion }
  if (raw.clientCapabilities !== undefined) {
    if (!isRecord(raw.clientCapabilities)) return err("clientCapabilities must be an object")
    const caps: ClientCapabilities = {}
    if (raw.clientCapabilities.fs !== undefined) {
      if (!isRecord(raw.clientCapabilities.fs))
        return err("clientCapabilities.fs must be an object")
      caps.fs = {
        readTextFile:
          typeof raw.clientCapabilities.fs.readTextFile === "boolean"
            ? raw.clientCapabilities.fs.readTextFile
            : undefined,
        writeTextFile:
          typeof raw.clientCapabilities.fs.writeTextFile === "boolean"
            ? raw.clientCapabilities.fs.writeTextFile
            : undefined,
      }
    }
    if (typeof raw.clientCapabilities.terminal === "boolean") {
      caps.terminal = raw.clientCapabilities.terminal
    }
    result.clientCapabilities = caps
  }
  if (raw.clientInfo !== undefined) {
    if (!isRecord(raw.clientInfo) || typeof raw.clientInfo.name !== "string") {
      return err("clientInfo.name must be a string")
    }
    result.clientInfo = {
      name: raw.clientInfo.name,
      title: typeof raw.clientInfo.title === "string" ? raw.clientInfo.title : undefined,
      version: typeof raw.clientInfo.version === "string" ? raw.clientInfo.version : undefined,
    }
  }
  return ok(result)
}

export interface AgentCapabilities {
  loadSession: boolean
  promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean }
  /** stdio MCP is mandatory; http/sse are opt-in. McpHub speaks stdio and
   * streamable HTTP but not legacy HTTP+SSE. */
  mcpCapabilities: { http: boolean; sse: boolean }
}

export interface AgentInfo {
  name: string
  title?: string
  version?: string
}

// session/new

export interface McpServerConfigAcp {
  name: string
  command?: string
  args?: string[]
  env?: { name: string; value: string }[]
  url?: string
  headers?: { name: string; value: string }[]
}

export interface SessionNewParams {
  cwd: string
  mcpServers: McpServerConfigAcp[]
}

export function parseSessionNewParams(raw: unknown): ValidationResult<SessionNewParams> {
  if (!isRecord(raw)) return err("params must be an object")
  if (typeof raw.cwd !== "string" || raw.cwd === "") return err("cwd must be a non-empty string")
  let mcpServers: McpServerConfigAcp[] = []
  if (raw.mcpServers !== undefined) {
    if (!Array.isArray(raw.mcpServers)) return err("mcpServers must be an array")
    for (const entry of raw.mcpServers) {
      if (!isRecord(entry) || typeof entry.name !== "string") {
        return err("each mcpServers entry needs a name")
      }
    }
    mcpServers = raw.mcpServers as McpServerConfigAcp[]
  }
  return ok({ cwd: raw.cwd, mcpServers })
}

// content blocks

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "audio"; mimeType: string; data: string }
  | {
      type: "resource"
      resource:
        | { uri: string; mimeType?: string; text: string }
        | { uri: string; mimeType?: string; blob: string }
    }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string; size?: number }

function parseContentBlock(raw: unknown): ValidationResult<ContentBlock> {
  if (!isRecord(raw) || typeof raw.type !== "string") return err("content block needs a type")
  switch (raw.type) {
    case "text":
      if (typeof raw.text !== "string") return err("text content block needs text")
      return ok({ type: "text", text: raw.text })
    case "image":
      if (typeof raw.mimeType !== "string" || typeof raw.data !== "string") {
        return err("image content block needs mimeType + data")
      }
      return ok({ type: "image", mimeType: raw.mimeType, data: raw.data })
    case "audio":
      if (typeof raw.mimeType !== "string" || typeof raw.data !== "string") {
        return err("audio content block needs mimeType + data")
      }
      return ok({ type: "audio", mimeType: raw.mimeType, data: raw.data })
    case "resource": {
      if (!isRecord(raw.resource) || typeof raw.resource.uri !== "string") {
        return err("resource content block needs resource.uri")
      }
      const mimeType = typeof raw.resource.mimeType === "string" ? raw.resource.mimeType : undefined
      if (typeof raw.resource.text === "string") {
        return ok({
          type: "resource",
          resource: { uri: raw.resource.uri, mimeType, text: raw.resource.text },
        })
      }
      if (typeof raw.resource.blob === "string") {
        return ok({
          type: "resource",
          resource: { uri: raw.resource.uri, mimeType, blob: raw.resource.blob },
        })
      }
      return err("resource content block needs resource.text or resource.blob")
    }
    case "resource_link":
      if (typeof raw.uri !== "string") return err("resource_link content block needs uri")
      return ok({
        type: "resource_link",
        uri: raw.uri,
        name: typeof raw.name === "string" ? raw.name : undefined,
        mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
        size: typeof raw.size === "number" ? raw.size : undefined,
      })
    default:
      return err(`unknown content block type "${raw.type}"`)
  }
}

// session/prompt

export interface SessionPromptParams {
  sessionId: string
  prompt: ContentBlock[]
}

export function parseSessionPromptParams(raw: unknown): ValidationResult<SessionPromptParams> {
  if (!isRecord(raw)) return err("params must be an object")
  if (typeof raw.sessionId !== "string" || raw.sessionId === "") {
    return err("sessionId must be a non-empty string")
  }
  if (!Array.isArray(raw.prompt)) return err("prompt must be an array of content blocks")
  const blocks: ContentBlock[] = []
  for (const item of raw.prompt) {
    const parsed = parseContentBlock(item)
    if (!parsed.ok) return parsed
    blocks.push(parsed.data)
  }
  return ok({ sessionId: raw.sessionId, prompt: blocks })
}

// session/cancel: notification, params only

export interface SessionCancelParams {
  sessionId: string
}

export function parseSessionCancelParams(raw: unknown): ValidationResult<SessionCancelParams> {
  if (!isRecord(raw)) return err("params must be an object")
  if (typeof raw.sessionId !== "string" || raw.sessionId === "") {
    return err("sessionId must be a non-empty string")
  }
  return ok({ sessionId: raw.sessionId })
}

// session/request_permission: Agent -> Client request

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"

export interface PermissionOption {
  optionId: string
  name: string
  kind: PermissionOptionKind
}

export type RequestPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" }

export function parseRequestPermissionResult(
  raw: unknown,
): ValidationResult<{ outcome: RequestPermissionOutcome }> {
  if (!isRecord(raw) || !isRecord(raw.outcome) || typeof raw.outcome.outcome !== "string") {
    return err("result.outcome.outcome is required (the doubled key is real — ACP §8.4)")
  }
  if (raw.outcome.outcome === "cancelled") return ok({ outcome: { outcome: "cancelled" } })
  if (raw.outcome.outcome === "selected" && typeof raw.outcome.optionId === "string") {
    return ok({ outcome: { outcome: "selected", optionId: raw.outcome.optionId } })
  }
  return err('outcome must be "cancelled" or {"outcome":"selected","optionId":string}')
}

// session/update: Agent -> Client notification payloads we emit

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other"

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string }

export interface ToolCallLocation {
  path: string
  line?: number
}

export interface PlanEntry {
  content: string
  priority: "high" | "medium" | "low"
  status: "pending" | "in_progress" | "completed"
}

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock; messageId?: string }
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock; messageId?: string }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock; messageId?: string }
  | {
      sessionUpdate: "tool_call"
      toolCallId: string
      title: string
      kind?: ToolKind
      status?: ToolCallStatus
      content?: ToolCallContent[]
      locations?: ToolCallLocation[]
      rawInput?: unknown
      rawOutput?: unknown
    }
  | {
      sessionUpdate: "tool_call_update"
      toolCallId: string
      kind?: ToolKind
      status?: ToolCallStatus
      title?: string
      content?: ToolCallContent[]
      locations?: ToolCallLocation[]
      rawInput?: unknown
      rawOutput?: unknown
    }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }

// stopReason

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"

// error codes

export const ACP_AUTH_REQUIRED = -32000

/**
 * A `session/prompt` arrived while that session already has a turn in flight.
 * -32001 sits in JSON-RPC's implementation-defined range and is not claimed
 * by ACP (-32000 auth_required, -32800 cancelled). Overlapping turns would
 * interleave writes into one journal, so we refuse instead of queueing.
 * Concurrency across sessions is unaffected.
 */
export const ACP_SESSION_BUSY = -32001
