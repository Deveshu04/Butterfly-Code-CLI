/** Shared by every backend in web/backends.ts and web/extract.ts. */

/** Merges a caller signal with a hard per-call timeout (never left un-timed-out). */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/** Caps a snippet/summary at `max` chars with an ellipsis marker. */
export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}
