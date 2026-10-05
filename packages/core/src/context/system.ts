import { PROMPT_ANTHROPIC, PROMPT_DEFAULT, PROMPT_GEMINI, PROMPT_GPT } from "./prompts"

export type PromptFamily = "default" | "anthropic" | "gpt" | "gemini"

const FAMILY_PROMPTS: Record<PromptFamily, string> = {
  default: PROMPT_DEFAULT,
  anthropic: PROMPT_ANTHROPIC,
  gpt: PROMPT_GPT,
  gemini: PROMPT_GEMINI,
}

export function selectPromptFamily(modelId: string): PromptFamily {
  const id = modelId.toLowerCase()
  if (id.includes("claude") || id.includes("anthropic")) return "anthropic"
  if (id.includes("gpt") || id.includes("codex") || id.includes("openai/o")) return "gpt"
  if (id.includes("gemini")) return "gemini"
  return "default"
}

export interface SystemEnv {
  cwd: string
  platform: string
  /** Day granularity — the prefix must stay byte-stable within a session. */
  date: string
  /** Frozen memory snapshots, loaded once per session. */
  projectMemory?: string
  userMemory?: string
  /** Skills index (name - description lines). */
  skillsIndex?: string
}

/**
 * Build the immutable system prefix (family prompt + environment block).
 * Frozen at session start so the prompt cache stays valid.
 */
export function buildSystem(modelId: string, env: SystemEnv): string {
  const family = selectPromptFamily(modelId)
  const parts = [
    FAMILY_PROMPTS[family],
    `# Environment
Working directory: ${env.cwd}
Platform: ${env.platform}
Today's date: ${env.date}`,
  ]
  if (env.projectMemory && env.projectMemory.trim() !== "") {
    parts.push(`# Project memory\n${env.projectMemory.trim()}`)
  }
  if (env.userMemory && env.userMemory.trim() !== "") {
    parts.push(`# User preferences\n${env.userMemory.trim()}`)
  }
  if (env.skillsIndex && env.skillsIndex.trim() !== "") {
    parts.push(
      `# Skills (load the full procedure with the skill tool before using one)\n${env.skillsIndex.trim()}`,
    )
  }
  return parts.join("\n\n")
}
