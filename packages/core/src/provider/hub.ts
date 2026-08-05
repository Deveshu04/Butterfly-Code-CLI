import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import type { ButterflyConfig } from "../config/config"

export interface ParsedModelRef {
  providerId: string
  modelId: string
}

/** "openrouter/deepseek/deepseek-chat" → provider "openrouter", model "deepseek/deepseek-chat". */
export function parseModelRef(ref: string): ParsedModelRef {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(
      `Model ref "${ref}" must be "provider/model", e.g. "openrouter/qwen/qwen3-coder" or "anthropic/claude-sonnet-4-6".`,
    )
  }
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

interface Preset {
  kind: "anthropic" | "google" | "openai-compatible"
  baseURL?: string
  envKey?: string
  headers?: Record<string, string>
}

const PRESETS: Record<string, Preset> = {
  anthropic: { kind: "anthropic", envKey: "ANTHROPIC_API_KEY" },
  google: { kind: "google", envKey: "GOOGLE_GENERATIVE_AI_API_KEY" },
  openrouter: {
    kind: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    headers: {
      "HTTP-Referer": "https://github.com/butterfly-labs/butterfly-code",
      "X-Title": "Butterfly Code",
    },
  },
  nvidia: {
    kind: "openai-compatible",
    baseURL: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
  },
  openai: {
    kind: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
  },
  ollama: { kind: "openai-compatible", baseURL: "http://localhost:11434/v1" },
  lmstudio: { kind: "openai-compatible", baseURL: "http://127.0.0.1:1234/v1" },
}

/** Which env var (if any) a provider preset expects an API key from — /doctor's key-presence check. */
export function presetEnvKey(providerId: string): string | undefined {
  return PRESETS[providerId]?.envKey
}

export interface ResolvedModel {
  model: LanguageModel
  providerId: string
}

export type ModelResolver = (ref: string) => ResolvedModel

export function createModelResolver(
  config: ButterflyConfig,
  env: Record<string, string | undefined> = process.env,
): ModelResolver {
  return (ref: string): ResolvedModel => {
    const { providerId, modelId } = parseModelRef(ref)
    const preset = PRESETS[providerId]
    const override = config.providers?.[providerId]
    const apiKey = override?.apiKey || (preset?.envKey ? env[preset.envKey] : undefined)
    const baseURL = override?.baseURL ?? preset?.baseURL
    const headers = { ...preset?.headers, ...override?.headers }

    const kind = preset?.kind ?? "openai-compatible"
    if (kind === "anthropic") {
      const provider = createAnthropic({ ...(apiKey ? { apiKey } : {}), headers })
      return { model: provider(modelId), providerId }
    }
    if (kind === "google") {
      const provider = createGoogleGenerativeAI({ ...(apiKey ? { apiKey } : {}), headers })
      return { model: provider(modelId), providerId }
    }
    if (!baseURL) {
      throw new Error(
        `Unknown provider "${providerId}" — add a baseURL under providers.${providerId} in butterfly.jsonc (any OpenAI-compatible endpoint works).`,
      )
    }
    const provider = createOpenAICompatible({
      name: providerId,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      headers,
      includeUsage: true,
      // Bun's fetch has a 300s idle timeout that races the SDK's own timeout
      // config; disable it here — the adapter's timeout settings govern.
      fetch: ((url, init) =>
        // biome-ignore lint/suspicious/noExplicitAny: Bun fetch extension
        fetch(url as any, { ...(init as object), timeout: false } as any)) as typeof fetch,
    })
    return { model: provider.chatModel(modelId), providerId }
  }
}
