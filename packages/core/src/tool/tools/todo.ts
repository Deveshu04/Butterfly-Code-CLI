import { z } from "zod"
import type { ToolDefinition } from "../registry"

export const todoInput = z.object({
  items: z.array(
    z.object({
      text: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
})

export type TodoItem = z.infer<typeof todoInput>["items"][number]

export const TODO_STATE_KEY = "todos"

const MARK: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
}

export function renderTodos(items: TodoItem[]): string {
  return items.map((item) => `${MARK[item.status]} ${item.text}`).join("\n")
}

export const todoTool: ToolDefinition<z.infer<typeof todoInput>> = {
  name: "todo",
  description:
    "Replace the session todo list. Use it to plan multi-step work and recite progress; keep at most one item in_progress.",
  inputSchema: todoInput,
  async execute(input, ctx) {
    ctx.state[TODO_STATE_KEY] = input.items
    // UI-only meta for the todo card; assembly never forwards meta to the model.
    if (input.items.length === 0) {
      return { output: "(todo list cleared)", meta: { todos: [] } }
    }
    return { output: renderTodos(input.items), meta: { todos: input.items } }
  },
}
