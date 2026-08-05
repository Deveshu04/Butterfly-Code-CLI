import type { Usage } from "../session/events"
import { SessionJournal } from "../session/journal"


export interface SessionMetrics {
  usage: Usage
  turns: number
  steps: number
  toolCalls: number
  toolErrors: number
  editCalls: number
  /** edit calls rejected by the apply/syntax gates. */
  malformedEdits: number
}

export function extractSessionMetrics(journalPath: string): SessionMetrics {
  const { events } = SessionJournal.replay(journalPath)
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  let editCalls = 0
  let malformedEdits = 0
  const editCallIds = new Set<string>()

  for (const event of events) {
    switch (event.type) {
      case "turn.completed":
        turns += 1
        usage.input += event.usage.input
        usage.output += event.usage.output
        usage.cacheRead += event.usage.cacheRead
        usage.cacheWrite += event.usage.cacheWrite
        break
      case "message.assistant":
        steps += 1
        break
      case "tool.call":
        toolCalls += 1
        if (event.name === "edit") {
          editCalls += 1
          editCallIds.add(event.callId)
        }
        break
      case "tool.result":
        if (event.isError) {
          toolErrors += 1
          if (editCallIds.has(event.callId)) malformedEdits += 1
        }
        break
      default:
        break
    }
  }

  return { usage, turns, steps, toolCalls, toolErrors, editCalls, malformedEdits }
}
