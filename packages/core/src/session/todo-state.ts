import { resolveToolName } from "../tool/repair"
import { type TodoItem, todoInput } from "../tool/tools/todo"

export { renderTodos } from "../tool/tools/todo"

import type { SessionEvent } from "./events"

/** True for "todo" and the names the registry repairs to it ("TodoWrite"). */
export const isTodoCall = (name: string): boolean => resolveToolName(name, ["todo"]) === "todo"

export function todosFromTimeline(timeline: SessionEvent[]): TodoItem[] | undefined {
  const todoInputs = new Map<string, unknown>()
  let latest: TodoItem[] | undefined
  for (const event of timeline) {
    if (event.type === "tool.call" && isTodoCall(event.name)) {
      todoInputs.set(event.callId, event.input)
    } else if (event.type === "tool.result" && todoInputs.has(event.callId) && !event.isError) {
      const parsed = todoInput.safeParse(todoInputs.get(event.callId))
      if (parsed.success) latest = parsed.data.items
    } else if (event.type === "session.compacted") {
      latest = event.todos
    }
  }
  return latest
}

/** callId of the result that currently defines the todo list (exempt from pruning). */
export function latestTodoResultId(timeline: SessionEvent[]): string | undefined {
  const todoCalls = new Set<string>()
  let latest: string | undefined
  for (const event of timeline) {
    if (event.type === "tool.call" && isTodoCall(event.name)) todoCalls.add(event.callId)
    else if (event.type === "tool.result" && todoCalls.has(event.callId) && !event.isError) {
      latest = event.callId
    }
  }
  return latest
}
