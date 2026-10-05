import { renderAgentsMdBlock } from "../context/agents-md"
import { loadImagePart, strippedImagePart } from "../context/media"
import type { ChatMessage, ChatMessagePart, ToolCallPart } from "../provider/port"
import type { SessionEvent } from "./events"

export interface AssembleOptions {
  /** The immutable system prefix (prompt family + frozen context sources). */
  system: string
  /** The projected, effective timeline (post-compaction, post-prune). */
  timeline: SessionEvent[]
  /**
   * Only an explicit `true` sends image parts; otherwise attachments render
   * as path-naming text, so text-only models never reject the request.
   */
  imageInputSupported?: boolean
}

/** Stand-in for a `tool.call` whose result never reached the journal
 * (e.g. the process died mid-call). */
export const UNANSWERED_CALL_OUTPUT = "[no result recorded — session was interrupted]"

/**
 * Fold the effective timeline into provider-neutral chat messages: system
 * first and byte-stable, transcript append-only. Pure and deterministic.
 *
 * Providers reject a tool call without a matching result, so any unanswered
 * `tool.call` gets a synthesized error result at the next turn boundary or
 * the end of the timeline. The journal itself is never rewritten.
 */
export function assemble(opts: AssembleOptions): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: opts.system }]
  const callNames = new Map<string, string>()
  const answeredCalls = new Set<string>()

  const closeOrphanedCalls = (): void => {
    for (const [callId, name] of callNames) {
      if (answeredCalls.has(callId)) continue
      messages.push({
        role: "tool",
        callId,
        name,
        output: UNANSWERED_CALL_OUTPUT,
        isError: true,
      })
      answeredCalls.add(callId)
    }
  }

  // Reasoning is sent back only for the current turn's steps; older turns'
  // reasoning would be re-billed on every step.
  let currentTurnStart = 0
  opts.timeline.forEach((event, index) => {
    if (event.type === "message.user") currentTurnStart = index
  })

  for (const [index, event] of opts.timeline.entries()) {
    switch (event.type) {
      case "message.user":
        // Close orphans before the new turn so results stay adjacent to
        // their assistant message.
        closeOrphanedCalls()
        if (event.images && event.images.length > 0) {
          // A missing or changed file degrades to a placeholder text part.
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
        messages.push({
          role: "assistant",
          content: event.text,
          ...(event.reasoning !== undefined && index > currentTurnStart
            ? { reasoning: event.reasoning }
            : {}),
        })
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
        answeredCalls.add(event.callId)
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
        // `scope` is model-visible here, which is why review.ts validates it.
        messages.push({
          role: "user",
          content: `[Code review of ${event.scope ?? "the current diff"} — summary from a read-only review subagent]\n${event.summary}`,
        })
        break
      case "context.fragment": {
        // A warning-only event (no fragments) renders nothing.
        const block = renderAgentsMdBlock(event.fragments)
        if (block !== "") messages.push({ role: "user", content: block })
        break
      }
      default:
        break
    }
  }
  closeOrphanedCalls()

  return messages
}
