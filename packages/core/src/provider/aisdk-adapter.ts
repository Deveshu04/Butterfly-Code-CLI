import { jsonSchema, type ModelMessage, streamText, tool } from "ai"
import type { Usage } from "../session/events"
import {
  classifyProviderError,
  describeProviderError,
  type ProviderErrorInfo,
} from "./describe-error"
import { EXPLICIT_REASONING_OFF, type ModelResolver } from "./hub"
import type {
  ChatMessage,
  FinishReason,
  ProviderPort,
  ToolSpec,
  TurnEvent,
  TurnRequest,
} from "./port"


type AiUsage = {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
}

export function mapUsage(usage: AiUsage | undefined): Usage {
  return {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
  }
}

export function mapFinishReason(reason: string): FinishReason {
  if (reason === "stop") return "stop"
  if (reason === "tool-calls") return "tool-calls"
  if (reason === "length") return "length"
  return "error"
}

export function toModelMessages(
  messages: ChatMessage[],
  opts?: { sendReasoning?: boolean },
): {
  system?: string
  model: ModelMessage[]
} {
  let system: string | undefined
  const model: ModelMessage[] = []

  for (const message of messages) {
    switch (message.role) {
      case "system":
        system = message.content
        break
      case "user":
        model.push({
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    :
                      { type: "file" as const, mediaType: part.mediaType, data: part.data },
                ),
        })
        break
      case "assistant": {
        if (!message.toolCalls || message.toolCalls.length === 0) {
          model.push({ role: "assistant", content: message.content })
          break
        }
        // OpenAI-compatible providers serialize a reasoning part as the
        // message's reasoning_content — what DeepSeek-style thinking models
        // require back inside a tool loop.
        const reasoning =
          opts?.sendReasoning === true && message.reasoning
            ? [{ type: "reasoning" as const, text: message.reasoning }]
            : []
        model.push({
          role: "assistant",
          content: [
            ...reasoning,
            ...(message.content !== "" ? [{ type: "text" as const, text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool-call" as const,
              toolCallId: call.callId,
              toolName: call.name,
              input: call.input,
            })),
          ],
        })
        break
      }
      case "tool":
        model.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.callId,
              toolName: message.name,
              // Several OpenAI-compatible gateways (Sarvam among them) 400 on
              // whitespace-only tool content, and the identical request then
              // fails on every retry — never send an empty tool result.
              output: {
                type: "text",
                value: message.output.trim() === "" ? "(no output)" : message.output,
              },
            },
          ],
        })
        break
    }
  }

  return { system, model }
}

export function withAnthropicCacheBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  const marked = [...messages]
  const mark = (index: number) => {
    const message = marked[index]
    if (!message) return
    marked[index] = {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        anthropic: {
          ...message.providerOptions?.["anthropic"],
          cacheControl: { type: "ephemeral" },
        },
      },
    } as ModelMessage
  }
  const last = marked.length - 1
  if (last < 0) return marked
  mark(last)
  for (let i = last - 1; i >= 0; i--) {
    const role = marked[i]?.role
    if (role === "user" || role === "tool") {
      mark(i)
      break
    }
  }
  return marked
}

function toSdkTools(specs: ToolSpec[] | undefined) {
  if (!specs || specs.length === 0) return undefined
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        // biome-ignore lint/suspicious/noExplicitAny: JSON Schema handoff at the wire seam
        inputSchema: jsonSchema(spec.inputSchema as any),
      }),
    ]),
  )
}

export function buildErrorEvent(
  error: unknown,
  providerId: string,
): Extract<TurnEvent, { type: "error" }> {
  const classified = classifyProviderError(error)
  const info: ProviderErrorInfo =
    classified.provider === undefined ? { ...classified, provider: providerId } : classified
  return { type: "error", message: describeProviderError(info), info }
}

const STREAM_TIMEOUT_MS = Number(process.env["BUTTERFLY_STREAM_TIMEOUT_MS"]) || 300_000

export class AiSdkProvider implements ProviderPort {
  constructor(private resolveModel: ModelResolver) {}

  async *streamTurn(request: TurnRequest): AsyncIterable<TurnEvent> {
    const { model, providerId } = this.resolveModel(request.model)
    // Native Anthropic/Gemini reasoning needs provider signatures we don't
    // keep; only OpenAI-compatible endpoints take plain reasoning_content.
    const converted = toModelMessages(request.messages, {
      sendReasoning: providerId !== "anthropic" && providerId !== "google",
    })
    const system = converted.system
    const messages =
      providerId === "anthropic" ? withAnthropicCacheBreakpoints(converted.model) : converted.model

    const instructions =
      system === undefined
        ? undefined
        : providerId === "anthropic"
          ? {
              role: "system" as const,
              content: system,
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
            }
          : system

    const result = streamText({
      model,
      ...(instructions !== undefined ? { instructions } : {}),
      messages,
      tools: toSdkTools(request.tools),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
      // The SDK drops reasoning "none" from the wire (omits reasoning_effort),
      // which some vendors read as "thinking ON" — forward it explicitly so
      // the preset's body transform can turn it into the vendor's real "off".
      ...(request.reasoning === "none" && EXPLICIT_REASONING_OFF.has(providerId)
        ? { providerOptions: { [providerId]: { reasoningEffort: "none" } } }
        : {}),
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
      maxRetries: 0,
      // Local models (Ollama/LM Studio) cold-start into RAM on first request,
      // and CPU-only prompt eval can take minutes. Generous per-chunk, no
      // total cap; BUTTERFLY_STREAM_TIMEOUT_MS overrides for slow machines.
      timeout: { firstChunkMs: STREAM_TIMEOUT_MS, chunkMs: STREAM_TIMEOUT_MS },
      onError: () => {},
    })

    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let finishReason: FinishReason = "stop"
    let sawFinish = false
    let truncated = false

    try {
      for await (const part of result.stream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text-delta", text: part.text }
            break
          case "reasoning-delta":
            yield { type: "reasoning-delta", text: part.text }
            break
          case "tool-call":
            yield {
              type: "tool-call",
              callId: part.toolCallId,
              name: part.toolName,
              input: part.input,
            }
            break
          case "finish-step": {
            usage = mapUsage(part.usage as AiUsage)
            const step = part as { finishReason?: string; rawFinishReason?: string }
            // The SDK synthesizes a finish when the SSE stream simply ends:
            // "other", no raw provider reason, no usage. A real completion
            // always carries the provider's own finish_reason.
            truncated =
              (step.finishReason === "other" || step.finishReason === "unknown") &&
              step.rawFinishReason === undefined &&
              (part.usage as AiUsage | undefined)?.inputTokens === undefined
            break
          }
          case "finish":
            sawFinish = true
            finishReason = mapFinishReason(part.finishReason)
            break
          case "error":
            yield buildErrorEvent(part.error, providerId)
            return
          default:
            break
        }
      }
    } catch (error) {
      yield buildErrorEvent(error, providerId)
      return
    }

    if ((!sawFinish || truncated) && request.signal?.aborted !== true) {
      const info: ProviderErrorInfo = {
        kind: "network",
        message: "the response stream ended before the provider finished (connection dropped)",
        provider: providerId,
      }
      yield { type: "error", message: describeProviderError(info), info }
      return
    }
    yield { type: "finish", reason: finishReason, usage }
  }
}
