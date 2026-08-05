import { jsonSchema, type ModelMessage, streamText, tool } from "ai"
import type { Usage } from "../session/events"
import type { ModelResolver } from "./hub"
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

export function toModelMessages(messages: ChatMessage[]): {
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
        model.push({
          role: "assistant",
          content: [
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
              output: { type: "text", value: message.output },
            },
          ],
        })
        break
    }
  }

  return { system, model }
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

const STREAM_TIMEOUT_MS = Number(process.env["BUTTERFLY_STREAM_TIMEOUT_MS"]) || 300_000

export class AiSdkProvider implements ProviderPort {
  constructor(private resolveModel: ModelResolver) {}

  async *streamTurn(request: TurnRequest): AsyncIterable<TurnEvent> {
    const { model, providerId } = this.resolveModel(request.model)
    const { system, model: messages } = toModelMessages(request.messages)

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
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
      ...(request.signal ? { abortSignal: request.signal } : {}),
      maxRetries: 2,
      // Local models (Ollama/LM Studio) cold-start into RAM on first request,
      // and CPU-only prompt eval can take minutes. Generous per-chunk, no
      // total cap; BUTTERFLY_STREAM_TIMEOUT_MS overrides for slow machines.
      timeout: { firstChunkMs: STREAM_TIMEOUT_MS, chunkMs: STREAM_TIMEOUT_MS },
      onError: () => {},
    })

    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let finishReason: FinishReason = "stop"

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
          case "finish-step":
            usage = mapUsage(part.usage as AiUsage)
            break
          case "finish":
            finishReason = mapFinishReason(part.finishReason)
            break
          case "error":
            yield { type: "error", message: describeError(part.error) }
            return
          default:
            break
        }
      }
    } catch (error) {
      yield { type: "error", message: describeError(error) }
      return
    }

    yield { type: "finish", reason: finishReason, usage }
  }
}
