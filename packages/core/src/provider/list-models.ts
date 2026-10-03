import { BUILTIN_MODELS, fetchOllamaModels } from "./models-catalog"


export interface ProviderModel {
  id: string
  name?: string
  context?: number
}

export interface ListModelsOptions {
  apiKey?: string
  baseURL?: string
  fetchFn?: typeof fetch
}

const NON_CHAT_OPENAI = /embed|whisper|tts|dall-e|audio|realtime|moderation|image|batch/i

export async function fetchProviderModels(
  providerId: string,
  opts: ListModelsOptions = {},
): Promise<ProviderModel[]> {
  const fetchFn = opts.fetchFn ?? fetch
  try {
    switch (providerId) {
      case "openrouter": {
        const response = await fetchFn(`${opts.baseURL ?? "https://openrouter.ai/api/v1"}/models`)
        if (!response.ok) return []
        const body = (await response.json()) as {
          data?: { id: string; name?: string; context_length?: number }[]
        }
        return (body.data ?? []).map((m) => ({ id: m.id, name: m.name, context: m.context_length }))
      }
      case "anthropic": {
        const response = await fetchFn("https://api.anthropic.com/v1/models?limit=1000", {
          headers: {
            "x-api-key": opts.apiKey ?? "",
            "anthropic-version": "2023-06-01",
          },
        })
        if (!response.ok) return []
        const body = (await response.json()) as {
          data?: { id: string; display_name?: string; max_input_tokens?: number }[]
        }
        return (body.data ?? []).map((m) => ({
          id: m.id,
          name: m.display_name,
          context: m.max_input_tokens,
        }))
      }
      case "google": {
        const response = await fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${opts.apiKey ?? ""}`,
        )
        if (!response.ok) return []
        const body = (await response.json()) as {
          models?: {
            name: string
            displayName?: string
            inputTokenLimit?: number
            supportedGenerationMethods?: string[]
          }[]
        }
        return (body.models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => ({
            id: m.name.replace(/^models\//, ""),
            name: m.displayName,
            context: m.inputTokenLimit,
          }))
      }
      case "openai":
      case "nvidia": {
        const base =
          opts.baseURL ??
          (providerId === "openai"
            ? "https://api.openai.com/v1"
            : "https://integrate.api.nvidia.com/v1")
        const response = await fetchFn(`${base}/models`, {
          headers: { Authorization: `Bearer ${opts.apiKey ?? ""}` },
        })
        if (!response.ok) return []
        const body = (await response.json()) as { data?: { id: string }[] }
        const models = (body.data ?? []).map((m) => ({ id: m.id }))
        return providerId === "openai" ? models.filter((m) => !NON_CHAT_OPENAI.test(m.id)) : models
      }
      case "sarvam": {
        const base = opts.baseURL ?? "https://api.sarvam.ai/v1"
        try {
          const response = await fetchFn(`${base}/models`, {
            headers: {
              Authorization: `Bearer ${opts.apiKey ?? ""}`,
              "api-subscription-key": opts.apiKey ?? "",
            },
          })
          if (response.ok) {
            const body = (await response.json()) as { data?: { id: string }[] }
            const live = (body.data ?? []).map((m) => ({ id: m.id }))
            if (live.length > 0) return live
          }
        } catch {
          // fall through to the known lineup
        }
        return Object.entries(BUILTIN_MODELS["sarvam"] ?? {}).map(([id, entry]) => ({
          id,
          context: entry.context,
        }))
      }
      case "lmstudio": {
        // Native endpoint (0.4+) carries max_context_length; shim does not.
        const base = (opts.baseURL ?? "http://127.0.0.1:1234/v1").replace(/\/v1$/, "")
        const response = await fetchFn(`${base}/api/v1/models`)
        if (!response.ok) return []
        const body = (await response.json()) as {
          models?: {
            key: string
            display_name?: string
            max_context_length?: number
            type?: string
          }[]
        }
        return (body.models ?? [])
          .filter((m) => m.type === undefined || m.type === "llm")
          .map((m) => ({ id: m.key, name: m.display_name, context: m.max_context_length }))
      }
      case "ollama": {
        const base = (opts.baseURL ?? "http://localhost:11434/v1").replace(/\/v1$/, "")
        const names = await fetchOllamaModels(base, fetchFn)
        return names.map((id) => ({ id }))
      }
      default:
        return []
    }
  } catch {
    return []
  }
}
