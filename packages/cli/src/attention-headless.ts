import { type AttentionAction, clearProgressOsc } from "@butterfly/core"

/** The stream shape both helpers need — injectable so tests never need a PTY. */
type AttentionStream = Pick<NodeJS.WriteStream, "isTTY" | "write">

/**
 * Headless attention adapter for `run` and `loop run`: writes OSC sequences
 * to stderr, only when stderr is a TTY so piped output stays byte-clean.
 * stdout is reserved for program output and never gets OSC bytes.
 */
export function applyHeadlessAttention(
  actions: AttentionAction[],
  stream: AttentionStream = process.stderr,
): void {
  if (!stream.isTTY) return
  for (const action of actions) stream.write(action.osc)
}

/**
 * Synchronous, TTY-gated "no progress" write. Runs from `process.on("exit")`,
 * where async work is dropped and a throw would mask the real exit reason.
 */
export function clearHeadlessProgress(stream: AttentionStream = process.stderr): void {
  if (!stream.isTTY) return
  try {
    stream.write(clearProgressOsc())
  } catch {
    // a dying stream must never turn into the process's last error
  }
}

/**
 * Clears the OSC 9;4 progress indicator however the process dies (crash,
 * `process.exit`, Ctrl+C); some terminals otherwise show it forever.
 * Signals need their own handlers because "exit" isn't emitted on a signal
 * death; they re-exit with 128+signal so normal exit codes are unchanged.
 * `alsoOnExit` adds other synchronous teardown (e.g. reaping background
 * tasks) to the same paths and runs at most once. Returns an uninstaller.
 */
export function installProgressExitClear(
  stream: AttentionStream = process.stderr,
  alsoOnExit?: () => void,
): () => void {
  let cleared = false
  const clearOnce = (): void => {
    if (cleared) return
    cleared = true
    clearHeadlessProgress(stream)
    try {
      alsoOnExit?.()
    } catch {
      // teardown is best-effort — never the process's last error
    }
  }
  const onExit = (): void => clearOnce()
  const onSigint = (): void => {
    clearOnce()
    process.exit(130)
  }
  const onSigterm = (): void => {
    clearOnce()
    process.exit(143)
  }
  process.on("exit", onExit)
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  return () => {
    process.off("exit", onExit)
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
  }
}
