import { For, Show } from "solid-js"
import {
  type AgentEntry,
  agentCounts,
  agentRows,
  agentStripLine,
  planWindow,
  type TodoItemView,
  todoProgress,
  todoRows,
  todoStripLine,
  usageLines,
} from "./layout"
import { themeTokens } from "./theme"

export interface UsageView {
  ctxUsed: number
  ctxLimit?: number
  input: number
  output: number
  cacheRead: number
  costUSD: string
}

function Section(props: { title: string; grow?: boolean; shrink?: boolean; children: unknown }) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={themeTokens().border}
      title={` ${props.title} `}
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
      flexShrink={props.grow || props.shrink ? 1 : 0}
      flexGrow={props.grow ? 1 : 0}
      minHeight={3}
    >
      {props.children as never}
    </box>
  )
}

function PlanRows(props: { todos: TodoItemView[]; width: number; limit?: number }) {
  return (
    <Show
      when={props.todos.length > 0}
      fallback={<text fg={themeTokens().muted}>no plan yet</text>}
    >
      <For
        each={todoRows(props.todos, props.width).slice(0, props.limit ?? Number.MAX_SAFE_INTEGER)}
      >
        {(row) => (
          <text
            fg={
              row.status === "completed"
                ? themeTokens().muted
                : row.status === "in_progress"
                  ? themeTokens().accent
                  : themeTokens().fg
            }
          >
            {row.text}
          </text>
        )}
      </For>
    </Show>
  )
}

export function AgentList(props: { agents: AgentEntry[]; selectedKey?: string; width: number }) {
  return (
    <For each={props.agents}>
      {(agent, i) => {
        const selected = () => agent.key === props.selectedKey
        const rows = () => agentRows(agent, i() + 1, props.width, selected())
        const color = () =>
          agent.phase === "failed"
            ? themeTokens().error
            : agent.phase === "done"
              ? themeTokens().success
              : themeTokens().accent
        return (
          <box flexDirection="column">
            <text fg={selected() ? themeTokens().strong : color()}>
              {selected() ? <b>{rows()[0]}</b> : rows()[0]}
            </text>
            <text fg={themeTokens().muted}>{rows()[1]}</text>
          </box>
        )
      }}
    </For>
  )
}

export function Sidebar(props: {
  width: number
  model: string
  effort?: string
  planMode: boolean
  todos: TodoItemView[]
  agents: AgentEntry[]
  showAgents: boolean
  selectedAgentKey?: string
  usage: UsageView
  files: string[]
}) {
  const inner = () => props.width - 4
  const progress = () => todoProgress(props.todos)
  const window = () => planWindow(props.todos, 10)
  const counts = () => agentCounts(props.agents)
  return (
    <box width={props.width} flexShrink={0} flexDirection="column" minHeight={0}>
      <Section title="Session">
        <text fg={themeTokens().fg}>{props.model}</text>
        <text fg={themeTokens().muted}>
          {`effort ${props.effort ?? "default"}${props.planMode ? " · PLAN (read-only)" : ""}`}
        </text>
      </Section>
      <Show
        when={props.todos.length > 0}
        fallback={
          <Section title="Plan">
            <text fg={themeTokens().muted}>no plan yet</text>
          </Section>
        }
      >
        <Section title={`Plan ${progress().done}/${progress().total}`}>
          <Show when={window().doneBefore > 0}>
            <text fg={themeTokens().muted}>{`+${window().doneBefore} done`}</text>
          </Show>
          <PlanRows todos={window().items} width={inner()} />
          <Show when={window().moreAfter > 0}>
            <text fg={themeTokens().muted}>{`+${window().moreAfter} more`}</text>
          </Show>
        </Section>
      </Show>
      <Show when={props.showAgents && props.agents.length > 0}>
        <Section
          title={`Agents ${counts().running > 0 ? `${counts().running} running` : `${counts().total}`}`}
        >
          <AgentList
            agents={props.agents.slice(-6)}
            selectedKey={props.selectedAgentKey}
            width={inner()}
          />
          <text fg={themeTokens().muted}>Alt+Left/Right view · Esc back</text>
        </Section>
      </Show>
      <Show when={props.files.length > 0}>
        <Section title={`Files changed ${props.files.length}`}>
          <For each={props.files.slice(-6)}>
            {(file) => (
              <text fg={themeTokens().fg}>
                {file.length > inner() ? `~${file.slice(-(inner() - 1))}` : file}
              </text>
            )}
          </For>
          <Show when={props.files.length > 6}>
            <text fg={themeTokens().muted}>{`+${props.files.length - 6} more`}</text>
          </Show>
        </Section>
      </Show>
      {/* Usage is pinned to the bottom; free space sits above it. */}
      <box flexGrow={1} />
      <Section title="Context">
        <For each={usageLines({ ...props.usage, width: inner() })}>
          {(line, i) => (
            <text fg={i() === 0 ? themeTokens().accent : themeTokens().muted}>{line}</text>
          )}
        </For>
      </Section>
    </box>
  )
}

export function AgentsPane(props: { width: number; agents: AgentEntry[]; selectedKey?: string }) {
  const counts = () => agentCounts(props.agents)
  return (
    <box width={props.width} flexShrink={0} flexDirection="column" minHeight={0}>
      <Section
        title={`Agents ${counts().running > 0 ? `${counts().running}/${counts().total} running` : `${counts().total}`}`}
        grow
      >
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
          <AgentList
            agents={props.agents}
            selectedKey={props.selectedKey}
            width={props.width - 6 /* border + padding + the scrollbar's column */}
          />
        </scrollbox>
        <text fg={themeTokens().muted}>Alt+Left/Right view · Esc back</text>
      </Section>
    </box>
  )
}

/**
 * Narrow layout: plan and agents pinned above the composer, one line each;
 * Ctrl+T expands the plan to its items (up to 8 rows).
 */
export function PinnedStrip(props: {
  todos: TodoItemView[]
  agents: AgentEntry[]
  width: number
  expanded: boolean
}) {
  const plan = () => todoStripLine(props.todos, props.width - 4)
  const agents = () => agentStripLine(props.agents)
  return (
    <Show when={plan() !== "" || agents() !== ""}>
      <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2}>
        <Show when={plan() !== ""}>
          <Show
            when={props.expanded}
            fallback={<text fg={themeTokens().accent}>{`${plan()}  (Ctrl+T)`}</text>}
          >
            <text fg={themeTokens().accent}>
              {`plan ${todoProgress(props.todos).done}/${todoProgress(props.todos).total}  (Ctrl+T to collapse)`}
            </text>
            <PlanRows todos={props.todos} width={props.width - 4} limit={8} />
          </Show>
        </Show>
        <Show when={agents() !== ""}>
          <text fg={themeTokens().muted}>{agents()}</text>
        </Show>
      </box>
    </Show>
  )
}

/** Header over the center pane while a subagent's conversation is open. */
export function AgentViewHeader(props: { agent: AgentEntry; ordinal: number; total: number }) {
  return (
    <box flexShrink={0} flexDirection="row" paddingLeft={2}>
      <text fg={themeTokens().accent}>
        <b>{`agent ${props.ordinal}/${props.total}`}</b>
      </text>
      <text fg={themeTokens().muted}>
        {`  ${props.agent.model} · ${props.agent.phase}${props.agent.steps > 0 ? ` · ${props.agent.steps} steps` : ""}  —  Esc back to main · Alt+Left/Right previous/next`}
      </text>
    </box>
  )
}
