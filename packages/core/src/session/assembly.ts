import { renderAgentsMdBlock } from "../context/agents-md"
import { loadImagePart, strippedImagePart } from "../context/media"
import type { ChatMessage, ChatMessagePart, ToolCallPart } from "../provider/port"
import type { SessionEvent } from "./events"

export interface AssembleOptions {
  /** The immutable system prefix (prompt family + frozen context sources). */
  system: string
  /** The projected, effective timeline (post-compaction, post-prune). */
  timeline: SessionEvent[]
  imageInputSupported?: boolean
}

export function assemble(opts: AssembleOptions): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: opts.system }]
  const callNames = new Map<string, string>()

  for (const event of opts.timeline) {
    switch (event.type) {
      case "message.user":
        if (event.images && event.images.length > 0) {
          const parts: ChatMessagePart[] = []
          if (event.text !== "") parts.push({ type: "text", text: event.text })
          for (const image of event.images) {
            parts.push(
              opts.imageInputSupported === true ? loadImagePart(image) : strippedImagePart(image),
            )
          }
          messages.push({ role: "user", content: parts })
        } else {
          messages.push({ role: "user", content: event.text })
        }
        break
      case "message.assistant":
        messages.push({ role: "assistant", content: event.text })
        break
      case "tool.call": {
        callNames.set(event.callId, event.name)
        const call: ToolCallPart = {
          callId: event.callId,
          name: event.name,
          input: event.input,
        }
        const last = messages.at(-1)
        if (last?.role === "assistant") {
          last.toolCalls = [...(last.toolCalls ?? []), call]
        } else {
          messages.push({ role: "assistant", content: "", toolCalls: [call] })
        }
        break
      }
      case "tool.result":
        messages.push({
          role: "tool",
          callId: event.callId,
          name: callNames.get(event.callId) ?? "unknown",
          output: event.output,
          isError: event.isError || undefined,
        })
        break
      case "session.compacted":
        messages.push({
          role: "user",
          content: `[Summary of earlier work in this session — the full transcript was compacted]\n${event.summary}`,
        })
        break
      case "session.review":
        messages.push({
          role: "user",
          content: `[Code review of ${event.scope ?? "the current diff"} — summary from a read-only review subagent]\n${event.summary}`,
        })
        break
      case "context.fragment": {
        const block = renderAgentsMdBlock(event.fragments)
        if (block !== "") messages.push({ role: "user", content: block })
        break
      }
      default:
        break
    }
  }

  return messages
}
