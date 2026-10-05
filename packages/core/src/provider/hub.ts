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
  /** Env var that overrides `baseURL` (self-hosted gateways live anywhere). */
  baseURLEnv?: string
  envKey?: string
  headers?: Record<string, string>
  /** Header that carries the API key in addition to `Authorization: Bearer`. */
  keyHeader?: string
  /** Rewrites the outgoing JSON body — vendor quirks the SDK can't express. */
  transformBody?: (body: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Sarvam's OpenAI-compatible endpoint differs in four ways:
 *  - `reasoning_effort` accepts only low|medium|high|null, and omitting it
 *    leaves thinking on: minimal->low, xhigh->high, "none"->null.
 *  - tool-message `content` must contain a non-whitespace char.
 *  - role "developer" is rejected.
 *  - `max_completion_tokens` is ignored; max_tokens is the field.
 */
export function normalizeSarvamBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body }
  if ("reasoning_effort" in out) {
    const effort = out["reasoning_effort"]
    if (effort === "none" || effort === null) out["reasoning_effort"] = null
    else if (effort === "minimal") out["reasoning_effort"] = "low"
    else if (effort === "xhigh" || effort === "max") out["reasoning_effort"] = "high"
    else if (effort !== "low" && effort !== "medium" && effort !== "high")
      delete out["reasoning_effort"]
  }
  if (out["max_completion_tokens"] !== undefined && out["max_tokens"] === undefined) {
    out["max_tokens"] = out["max_completion_tokens"]
    delete out["max_completion_tokens"]
  }
  if (Array.isArray(out["messages"])) {
    out["messages"] = (out["messages"] as Record<string, unknown>[]).map((message) => {
      if (message?.["role"] === "developer") return { ...message, role: "system" }
      if (
        message?.["role"] === "tool" &&
        (typeof message["content"] !== "string" || message["content"].trim() === "")
      ) {
        return { ...message, content: "(no output)" }
      }
      return message
    })
  }
  return out
}

/**
 * Providers that need an EXPLICIT "reasoning off" on the wire — omitting the
 * field leaves thinking on, so the adapter forwards "none" verbatim (as a
 * providerOptions reasoningEffort) and the preset's transformBody maps it.
 */
export const EXPLICIT_REASONING_OFF: ReadonlySet<string> = new Set(["sarvam"])

/** Base URLs and API key env vars per provider. */
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
  sarvam: {
    kind: "openai-compatible",
    baseURL: "https://api.sarvam.ai/v1",
    envKey: "SARVAM_API_KEY",
    keyHeader: "api-subscription-key",
    transformBody: normalizeSarvamBody,
  },
  // LiteLLM proxy: model ids come from the proxy's model_list; the key is the
  // proxy's master/virtual key (optional on an open local proxy).
  litellm: {
    kind: "openai-compatible",
    baseURL: "http://localhost:4000/v1",
    baseURLEnv: "LITELLM_BASE_URL",
    envKey: "LITELLM_API_KEY",
  },
  ollama: { kind: "openai-compatible", baseURL: "http://localhost:11434/v1" },
  lmstudio: { kind: "openai-compatible", baseURL: "http://127.0.0.1:1234/v1" },
}

/** "http://host:4000" → "http://host:4000/v1" (LiteLLM serves both; the SDK appends /chat/completions). */
export function normalizeGatewayBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

/**
 * Providers whose model ids are chosen by the user's own deployment, not a
 * vendor catalog — "not in models.dev" is expected for them, never a typo.
 */
export const SELF_NAMED_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "litellm"])

/** Which env var (if any) a provider preset expects an API key from — /doctor's key-presence check. */
export function presetEnvKey(providerId: string): string | undefined {
  return PRESETS[providerId]?.envKey
}

/** The base URL a preset resolves to (env override applied) — for live model listing. */
export function presetBaseURL(
  providerId: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const preset = PRESETS[providerId]
  const fromEnv = preset?.baseURLEnv ? env[preset.baseURLEnv] : undefined
  return fromEnv ? normalizeGatewayBase(fromEnv) : preset?.baseURL
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
    const envBase = preset?.baseURLEnv ? env[preset.baseURLEnv] : undefined
    const baseURL = override?.baseURL ?? (envBase ? normalizeGatewayBase(envBase) : preset?.baseURL)
    const headers = {
      ...preset?.headers,
      ...(preset?.keyHeader && apiKey ? { [preset.keyHeader]: apiKey } : {}),
      ...override?.headers,
    }
    const transformBody = preset?.transformBody

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
      fetch: ((url, init) => {
        let next = init
        if (transformBody && typeof init?.body === "string") {
          try {
            next = { ...init, body: JSON.stringify(transformBody(JSON.parse(init.body))) }
          } catch {
            // not JSON — send untouched
          }
        }
        // biome-ignore lint/suspicious/noExplicitAny: Bun fetch extension
        return fetch(url as any, { ...(next as object), timeout: false } as any)
      }) as typeof fetch,
    })
    return { model: provider.chatModel(modelId), providerId }
  }
}
