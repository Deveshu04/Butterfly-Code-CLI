import type { Usage } from "../session/events"
import type { ProviderErrorInfo } from "./describe-error"


/** User-message content parts. Image `data` is base64, loaded at send time. */
export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }

export type ChatMessage =
  | { role: "system"; content: string; cacheHint?: boolean }
  | { role: "user"; content: string | ChatMessagePart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCallPart[]; reasoning?: string }
  | { role: "tool"; callId: string; name: string; output: string; isError?: boolean }

export interface ToolCallPart {
  callId: string
  name: string
  input: unknown
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>
}

/** Thinking-effort dial (the AI SDK `reasoning` option). */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

export interface TurnRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  maxOutputTokens?: number
  temperature?: number
  reasoning?: ReasoningEffort
  signal?: AbortSignal
}

export type FinishReason = "stop" | "tool-calls" | "length" | "error"

export type TurnEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  /**
   * The model STARTED writing a tool call (its arguments are still
   * streaming). UI-only: lets a client show "preparing edit…" during a long
   * argument stream instead of looking stuck. The matching "tool-call"
   * (same callId) follows once the arguments are complete.
   */
  | { type: "tool-input-start"; callId: string; name: string }
  | { type: "finish"; reason: FinishReason; usage: Usage }
  /** `message` is a human-readable line; `info` is the classified error. */
  | { type: "error"; message: string; info?: ProviderErrorInfo }

export interface ProviderPort {
  streamTurn(request: TurnRequest): AsyncIterable<TurnEvent>
}
