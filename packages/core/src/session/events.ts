import { z } from "zod"

/**
 * Journal event schemas. The JSONL journal is the source of truth (SQLite
 * indexes and UI state are derived): a header line, then one event per line.
 */

export const JOURNAL_VERSION = 1

export const JournalHeader = z.object({
  v: z.literal(JOURNAL_VERSION),
  kind: z.literal("butterfly-session"),
  sessionId: z.string(),
  createdAt: z.string(),
})
export type JournalHeader = z.infer<typeof JournalHeader>

export const Usage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
})
export type Usage = z.infer<typeof Usage>

const base = { time: z.string() }

export const SessionEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("session.created"),
    cwd: z.string(),
    title: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal("session.title"), title: z.string() }),
  z.object({
    ...base,
    type: z.literal("message.user"),
    id: z.string(),
    text: z.string(),
    /**
     * Harness-authored (the auto-continue nudge). The model sees a user
     * message; UIs show a harness note and turn-boundary logic skips it.
     */
    synthetic: z.boolean().optional(),
    /**
     * Image attachments as path + sha256 (never base64). Bytes are loaded and
     * verified at send time, and only if the current model accepts images.
     */
    images: z
      .array(z.object({ path: z.string(), mediaType: z.string(), sha256: z.string() }))
      .optional(),
  }),
  z.object({
    ...base,
    type: z.literal("message.assistant"),
    id: z.string(),
    text: z.string(),
    /**
     * Reasoning text, kept only for steps that made tool calls: some
     * OpenAI-compatible thinking models reject a tool loop whose assistant
     * messages drop their reasoning_content.
     */
    reasoning: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.call"),
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal("tool.result"),
    callId: z.string(),
    output: z.string(),
    isError: z.boolean(),
    truncated: z.boolean().optional(),
    /** UI-only metadata (diffs, paths) — assembly never forwards it. */
    meta: z.unknown().optional(),
  }),
  z.object({ ...base, type: z.literal("turn.completed"), model: z.string(), usage: Usage }),
  z.object({
    ...base,
    type: z.literal("session.compacted"),
    summary: z.string(),
    /** Events with index < keepFromIndex are superseded by the summary. */
    keepFromIndex: z.number(),
    /** The todo list as it stood at the cut (harness state, not model prose). */
    todos: z
      .array(
        z.object({
          text: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .optional(),
    /** Files changed via the edit tool up to the cut (cumulative across compactions). */
    files: z.array(z.string()).optional(),
  }),
  z.object({ ...base, type: z.literal("tool.pruned"), callIds: z.array(z.string()) }),
  /**
   * Worktree tree hash captured before a turn (no callId) or before a
   * mutating tool call. `untracked` lists files already untracked then, so
   * restore deletes only files created after the snapshot.
   */
  z.object({
    ...base,
    type: z.literal("turn.snapshot"),
    tree: z.string(),
    callId: z.string().optional(),
    tool: z.string().optional(),
    /** First line of the call's args, capped — picker label context. */
    argsPreview: z.string().optional(),
    untracked: z.array(z.string()).optional(),
  }),
  /** Conversation rewound: events with index >= toIndex leave the timeline. */
  z.object({ ...base, type: z.literal("session.rewound"), toIndex: z.number() }),
  /**
   * A /review result, rendered by assembly as a labelled user block.
   * `scope` is model-visible, so it is never free user text (ranges are
   * validated first). diffChars/truncated/journalPath are UI-only.
   */
  z.object({
    ...base,
    type: z.literal("session.review"),
    summary: z.string(),
    /** What was reviewed, e.g. "unstaged + staged changes" or "git diff HEAD~3". */
    scope: z.string().optional(),
    diffChars: z.number().optional(),
    truncated: z.boolean().optional(),
    /** The reviewing subagent's own isolated journal — full text lives there. */
    journalPath: z.string().optional(),
  }),
  /** One hook command's execution, for /hooks stats. Not model-visible. */
  z.object({
    ...base,
    type: z.literal("hook.run"),
    event: z.enum(["session.start", "turn.start", "pre.tool", "post.tool", "turn.end"]),
    command: z.string(),
    exitCode: z.number(),
    durationMs: z.number(),
    /** true only for a pre.tool hook whose failure blocked the tool call. */
    blocked: z.boolean(),
    /** true only for a failing post.tool hook configured with feedback:true. */
    feedback: z.boolean(),
    /** stdout+stderr, capped — journal/UI observability only, never model-visible. */
    outputHead: z.string(),
  }),
  /**
   * Nested AGENTS.md fragments for files touched this session. Appended to
   * the transcript, not the system prefix; a path is never reconsidered once
   * loaded or skipped.
   */
  z.object({
    ...base,
    type: z.literal("context.fragment"),
    source: z.literal("agents.md"),
    fragments: z.array(
      z.object({
        /** Absolute path — dedup identity. */
        path: z.string(),
        /** cwd-relative, forward-slash path — display only. */
        relPath: z.string(),
        content: z.string(),
        truncated: z.boolean(),
      }),
    ),
    /** Absolute paths newly rejected by the total budget this reconcile. */
    skipped: z.array(z.string()).optional(),
    warning: z.string().optional(),
  }),
  /**
   * A handoff doc was saved. Bookkeeping only; the doc text is already in
   * that turn's message.assistant.
   */
  z.object({
    ...base,
    type: z.literal("session.handoff"),
    /** `.butterfly/handoff.md` at save time. */
    path: z.string(),
    /** `.butterfly/handoffs/<ts>.md` — the permanent, never-overwritten copy. */
    archivePath: z.string(),
    chars: z.number(),
    truncated: z.boolean(),
  }),
  /** A `bash background:true` spawn. Bookkeeping only; `id` is the /tasks id. */
  z.object({
    ...base,
    type: z.literal("bgtask.start"),
    id: z.string(),
    command: z.string(),
    pid: z.number(),
    logPath: z.string(),
    keepAlive: z.boolean(),
  }),
  /** Terminal state of a background task (exit, kill, or reap on session exit). */
  z.object({
    ...base,
    type: z.literal("bgtask.end"),
    id: z.string(),
    status: z.enum(["exited", "killed"]),
    exitCode: z.number().optional(),
  }),
])
export type SessionEvent = z.infer<typeof SessionEvent>

export function now(): string {
  return new Date().toISOString()
}
