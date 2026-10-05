import type { ScrollBoxRenderable } from "@opentui/core"
import { Show } from "solid-js"
import type { PagerDoc } from "./pager"
import { SYNTAX, themeTokens } from "./theme"

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

/**
 * Full-screen transcript pager (Ctrl+O). Presentation only; app.tsx owns the
 * state and keys. Scroll-to-match uses the source line number, so it is
 * approximate rather than pixel-exact.
 */
export function PagerView(props: PagerViewProps) {
  const matchIndex = () => props.matches.indexOf(props.currentLine)
  const promptIndex = () => props.doc.promptLines.indexOf(props.currentLine)

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <box flexShrink={0} height={1} marginTop={1}>
        <text fg={themeTokens().muted}>{HELP_LINE}</text>
      </box>
      <scrollbox
        ref={props.scrollRef}
        flexGrow={1}
        minHeight={0}
        // Same gutter and themed track as the transcript scrollbox.
        viewportOptions={{ paddingRight: 2 }}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: themeTokens().bg,
            foregroundColor: themeTokens().border,
          },
        }}
      >
        <markdown content={props.doc.source} syntaxStyle={SYNTAX} internalBlockMode="top-level" />
      </scrollbox>
      <box flexShrink={0} height={1} flexDirection="row">
        <Show when={props.query !== ""}>
          <text fg={props.searchActive ? themeTokens().warn : themeTokens().muted}>
            {props.matches.length > 0
              ? `/${props.query}  match ${matchIndex() + 1}/${props.matches.length}`
              : `/${props.query}  no matches`}
          </text>
        </Show>
        <Show when={props.doc.promptLines.length > 0 && promptIndex() >= 0}>
          <text fg={themeTokens().muted}>
            {`  ·  prompt ${promptIndex() + 1}/${props.doc.promptLines.length}`}
          </text>
        </Show>
        <Show when={props.notice !== ""}>
          <text fg={themeTokens().muted}>{`  ·  ${props.notice}`}</text>
        </Show>
      </box>
    </box>
  )
}
