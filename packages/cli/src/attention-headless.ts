import { type AttentionAction, clearProgressOsc } from "@butterfly/core"

/** The stream shape both helpers need — injectable so tests never need a PTY. */
type AttentionStream = Pick<NodeJS.WriteStream, "isTTY" | "write">

export function applyHeadlessAttention(
  actions: AttentionAction[],
  stream: AttentionStream = process.stderr,
): void {
  if (!stream.isTTY) return
  for (const action of actions) stream.write(action.osc)
}

export function clearHeadlessProgress(stream: AttentionStream = process.stderr): void {
  if (!stream.isTTY) return
  try {
    stream.write(clearProgressOsc())
  } catch {
    // a dying stream must never turn into the process's last error
  }
}

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
