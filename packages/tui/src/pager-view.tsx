import type { ScrollBoxRenderable } from "@opentui/core"
import { Show } from "solid-js"
import type { PagerDoc } from "./pager"
import { SYNTAX, T } from "./theme"

export interface PagerViewProps {
  doc: PagerDoc
  query: string
  searchActive: boolean
  matches: number[]
  currentLine: number
  notice: string
  scrollRef: (r: ScrollBoxRenderable) => void
}

const HELP_LINE =
  "-- PAGER --  / search · n/N next/prev · { } prompts · [ scrollback · v $EDITOR · q/Esc/^O close"

export function PagerView(props: PagerViewProps) {
  const matchIndex = () => props.matches.indexOf(props.currentLine)
  const promptIndex = () => props.doc.promptLines.indexOf(props.currentLine)

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexShrink={0} height={1}>
        <text fg={T.textMuted}>{HELP_LINE}</text>
      </box>
      <scrollbox ref={props.scrollRef} flexGrow={1} minHeight={0}>
        <markdown content={props.doc.source} syntaxStyle={SYNTAX} internalBlockMode="top-level" />
      </scrollbox>
      <box flexShrink={0} height={1} flexDirection="row">
        <Show when={props.query !== ""}>
          <text fg={props.searchActive ? T.warn : T.textMuted}>
            {props.matches.length > 0
              ? `/${props.query}  match ${matchIndex() + 1}/${props.matches.length}`
              : `/${props.query}  no matches`}
          </text>
        </Show>
        <Show when={props.doc.promptLines.length > 0 && promptIndex() >= 0}>
          <text fg={T.textMuted}>
            {`  ·  prompt ${promptIndex() + 1}/${props.doc.promptLines.length}`}
          </text>
        </Show>
        <Show when={props.notice !== ""}>
          <text fg={T.textMuted}>{`  ·  ${props.notice}`}</text>
        </Show>
      </box>
    </box>
  )
}
