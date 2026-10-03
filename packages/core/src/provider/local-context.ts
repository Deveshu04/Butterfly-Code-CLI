
export const OLLAMA_DEFAULT_BASE = "http://localhost:11434/v1"
const PROBE_TIMEOUT_MS = 2_000

/** "http://host:11434/v1" → "http://host:11434" (the native API root). */
export function ollamaApiRoot(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

const withLatest = (name: string) => (name.includes(":") ? name : `${name}:latest`)

export async function probeOllamaContext(
  baseURL: string,
  model: string,
  fetchFn: typeof fetch = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchFn(`${ollamaApiRoot(baseURL)}/api/ps`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const data = (await response.json()) as {
      models?: { name?: string; model?: string; context_length?: unknown }[]
    }
    const wanted = withLatest(model)
    const entry = (data.models ?? []).find(
      (m) => withLatest(m.name ?? "") === wanted || withLatest(m.model ?? "") === wanted,
    )
    const length = entry?.context_length
    return typeof length === "number" && length > 0 ? length : undefined
  } catch {
    return undefined
  }
}

/** Room a turn needs beyond the fixed prefix before truncation is likely. */
export const LOCAL_CONTEXT_HEADROOM = 16_000

/**
 * The warning line when a served context is too small to work in, or
 * undefined when it is fine. `prefixTokens` = system prompt + tool schemas.
 */
export function servedContextWarning(
  model: string,
  served: number,
  prefixTokens: number,
): string | undefined {
  if (served >= prefixTokens + LOCAL_CONTEXT_HEADROOM) return undefined
  return `ollama is serving ${model} with a ${served.toLocaleString()}-token context — the fixed prefix alone is ~${prefixTokens.toLocaleString()} tokens, so longer requests are silently truncated. Set OLLAMA_CONTEXT_LENGTH=32768 (or more) and restart ollama.`
}
