import type { Usage } from "../session/events"
import type { ProviderErrorInfo } from "./describe-error"


export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }

export type ChatMessage =
  | { role: "system"; content: string; cacheHint?: boolean }
  | { role: "user"; content: string | ChatMessagePart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCallPart[] }
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

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high"

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
  | { type: "finish"; reason: FinishReason; usage: Usage }
  | { type: "error"; message: string; info?: ProviderErrorInfo }

export interface ProviderPort {
  streamTurn(request: TurnRequest): AsyncIterable<TurnEvent>
}
