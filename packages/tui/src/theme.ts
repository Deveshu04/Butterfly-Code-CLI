import { readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { SyntaxStyle } from "@opentui/core"
import { createSignal } from "solid-js"

/**
 * Semantic color tokens used by every TUI component; colors are never
 * hardcoded at call sites. A theme is a builtin base plus optional overrides
 * from `~/.config/butterfly/themes/*.json`, held in one reactive store.
 */
export interface ThemeTokens {
  bg: string
  fg: string
  muted: string
  accent: string
  success: string
  warn: string
  error: string
  border: string
  heading: string
  strong: string
  emph: string
  codeInline: string
  codeBlock: string
  link: string
  keyword: string
  string: string
  comment: string
  func: string
  number: string
  type: string
  /** <diff> element sign color for added lines. */
  diffAdd: string
  /** <diff> element sign color for removed lines. */
  diffDel: string
  diffAddBg: string
  diffDelBg: string
  diffContextBg: string
  diffLineNumber: string
  diffLineNumberBg: string
}

/**
 * Default theme. The diff colors match OpenTUI's `<diff>` built-in defaults,
 * so wiring them through tokens leaves the default look unchanged.
 */
export const DARK_TOKENS: ThemeTokens = {
  bg: "transparent",
  fg: "#e8e8e8",
  muted: "#8b8b8b",
  accent: "#c9a7ff",
  success: "#22c55e",
  warn: "#ffcc66",
  error: "#ff8080",
  border: "#8b8b8b",
  heading: "#ffffff",
  strong: "#ffffff",
  emph: "#d8d8d8",
  codeInline: "#a8d7a8",
  codeBlock: "#c8e0c8",
  link: "#8ab4ff",
  keyword: "#c586c0",
  string: "#ce9178",
  comment: "#6a9955",
  func: "#dcdcaa",
  number: "#b5cea8",
  type: "#4ec9b0",
  diffAdd: "#22c55e",
  diffDel: "#ef4444",
  diffAddBg: "#1a4d1a",
  diffDelBg: "#4d1a1a",
  diffContextBg: "transparent",
  diffLineNumber: "#888888",
  diffLineNumberBg: "transparent",
}

/** LIGHT — readable on a light-background terminal. */
export const LIGHT_TOKENS: ThemeTokens = {
  bg: "#ffffff",
  fg: "#1a1a1a",
  muted: "#666666",
  accent: "#7c3aed",
  success: "#15803d",
  warn: "#b45309",
  error: "#b91c1c",
  border: "#666666",
  heading: "#000000",
  strong: "#000000",
  emph: "#333333",
  codeInline: "#166534",
  codeBlock: "#166534",
  link: "#1d4ed8",
  keyword: "#7c3aed",
  string: "#b45309",
  comment: "#6b7280",
  func: "#92400e",
  number: "#0f766e",
  type: "#0f766e",
  diffAdd: "#15803d",
  diffDel: "#b91c1c",
  diffAddBg: "#dcfce7",
  diffDelBg: "#fee2e2",
  diffContextBg: "transparent",
  diffLineNumber: "#6b7280",
  diffLineNumberBg: "transparent",
}

/**
 * The 16 ANSI color names OpenTUI's `parseColor` recognizes; they downsample
 * predictably on limited-palette terminals.
 */
export const ANSI_COLOR_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightblack",
  "brightred",
  "brightgreen",
  "brightblue",
  "brightyellow",
  "brightcyan",
  "brightmagenta",
  "brightwhite",
] as const
export type AnsiColorName = (typeof ANSI_COLOR_NAMES)[number]

/**
 * 16-color-safe presets: every value is an ANSI_COLOR_NAME, except background
 * tokens, which stay "transparent" since the terminal palette is unknown.
 */
export const DARK_ANSI_TOKENS: ThemeTokens = {
  bg: "transparent",
  fg: "white",
  muted: "brightblack",
  accent: "brightmagenta",
  success: "brightgreen",
  warn: "brightyellow",
  error: "brightred",
  border: "brightblack",
  heading: "white",
  strong: "white",
  emph: "white",
  codeInline: "green",
  codeBlock: "green",
  link: "brightblue",
  keyword: "magenta",
  string: "yellow",
  comment: "green",
  func: "yellow",
  number: "cyan",
  type: "cyan",
  diffAdd: "brightgreen",
  diffDel: "brightred",
  diffAddBg: "transparent",
  diffDelBg: "transparent",
  diffContextBg: "transparent",
  diffLineNumber: "brightblack",
  diffLineNumberBg: "transparent",
}

export const LIGHT_ANSI_TOKENS: ThemeTokens = {
  bg: "transparent",
  fg: "black",
  muted: "brightblack",
  accent: "magenta",
  success: "green",
  warn: "yellow",
  error: "red",
  border: "brightblack",
  heading: "black",
  strong: "black",
  emph: "black",
  codeInline: "green",
  codeBlock: "green",
  link: "blue",
  keyword: "magenta",
  string: "green",
  comment: "brightblack",
  func: "blue",
  number: "cyan",
  type: "cyan",
  diffAdd: "green",
  diffDel: "red",
  diffAddBg: "transparent",
  diffDelBg: "transparent",
  diffContextBg: "transparent",
  diffLineNumber: "brightblack",
  diffLineNumberBg: "transparent",
}

export const BUILTIN_THEMES: Record<string, ThemeTokens> = {
  dark: DARK_TOKENS,
  light: LIGHT_TOKENS,
  "dark-ansi": DARK_ANSI_TOKENS,
  "light-ansi": LIGHT_ANSI_TOKENS,
}

/** Background tokens; "transparent" is allowed for these under the ANSI-safe check. */
const BACKGROUND_TOKEN_KEYS = new Set<keyof ThemeTokens>([
  "bg",
  "diffAddBg",
  "diffDelBg",
  "diffContextBg",
  "diffLineNumberBg",
])

/** True iff every token is an ANSI_COLOR_NAME or a transparent background. */
export function isAnsiSafeTheme(theme: ThemeTokens): boolean {
  const names: readonly string[] = ANSI_COLOR_NAMES
  return (Object.keys(theme) as (keyof ThemeTokens)[]).every((key) => {
    const value = theme[key]
    if (BACKGROUND_TOKEN_KEYS.has(key) && value === "transparent") return true
    return names.includes(value)
  })
}

const THEME_TOKEN_KEYS = new Set(Object.keys(DARK_TOKENS))

/**
 * A theme FILE on disk: `~/.config/butterfly/themes/<name>.json`, shape
 * `{"base": "<builtin>", "overrides": {"<token>": "<value>", ...}}`.
 */
export interface ThemeFile {
  base?: string
  overrides?: Record<string, unknown>
}

/**
 * Applies `overrides` on top of `base` without mutating it. Unknown keys and
 * non-string values are ignored so a typo in a theme file can't break rendering.
 */
export function applyOverrides(
  base: ThemeTokens,
  overrides?: Record<string, unknown>,
): ThemeTokens {
  if (!overrides) return base
  const result: ThemeTokens = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string" && THEME_TOKEN_KEYS.has(key)) {
      ;(result as unknown as Record<string, string>)[key] = value
    }
  }
  return result
}

/**
 * Resolves a theme name against built-ins and custom files. A custom file's
 * `base` defaults to "dark"; unknown names fall back to dark, never throw.
 */
export function resolveTheme(name: string, custom: Record<string, ThemeFile> = {}): ThemeTokens {
  const file = custom[name]
  if (file) {
    const base = (file.base && BUILTIN_THEMES[file.base]) || DARK_TOKENS
    return applyOverrides(base, file.overrides)
  }
  return BUILTIN_THEMES[name] ?? DARK_TOKENS
}

export function themesDir(home: string): string {
  return join(home, ".config", "butterfly", "themes")
}

/** Reads every `*.json` in themesDir(home). Malformed files and a missing dir are skipped. */
export function loadCustomThemes(home: string): Record<string, ThemeFile> {
  const dir = themesDir(home)
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return {}
  }
  const result: Record<string, ThemeFile> = {}
  for (const entry of entries) {
    const name = basename(entry, ".json")
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, entry), "utf8"))
      if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>
        result[name] = {
          base: typeof obj.base === "string" ? (obj.base as string) : undefined,
          overrides:
            obj.overrides && typeof obj.overrides === "object"
              ? (obj.overrides as Record<string, unknown>)
              : undefined,
        }
      }
    } catch {
      // malformed theme JSON: skip
    }
  }
  return result
}

/** Built-in and custom theme names, deduped and sorted, for the /theme picker. */
export function listThemeNames(home: string): string[] {
  const names = new Set<string>(Object.keys(BUILTIN_THEMES))
  for (const name of Object.keys(loadCustomThemes(home))) names.add(name)
  return [...names].sort()
}

/** Looks up a builtin theme by name, falling back to dark. */
export function builtinTheme(name: string): ThemeTokens {
  return BUILTIN_THEMES[name] ?? DARK_TOKENS
}

// --- Reactive store --------------------------------------------------------

/**
 * Reactive token store, seeded with DARK_TOKENS. app.tsx sets the real theme
 * synchronously on every mount, so each App starts from a known state.
 */
const [themeTokensSignal, setThemeTokensSignal] = createSignal<ThemeTokens>(DARK_TOKENS)

/** Current tokens. Call inside JSX (don't cache) so theme switches re-render. */
export function themeTokens(): ThemeTokens {
  return themeTokensSignal()
}

/** Set the resolved tokens directly (already-merged base+overrides). */
export function setThemeTokens(next: ThemeTokens): void {
  setThemeTokensSignal(next)
}

/**
 * Built once at module scope: SyntaxStyle wraps a native handle, and
 * recreating it per render leaks. Syntax colors do not follow theme switches.
 */
export const SYNTAX = SyntaxStyle.fromTheme([
  { scope: ["default"], style: { foreground: DARK_TOKENS.fg } },
  { scope: ["markup.heading"], style: { foreground: DARK_TOKENS.heading, bold: true } },
  {
    scope: ["markup.bold", "markup.strong"],
    style: { foreground: DARK_TOKENS.strong, bold: true },
  },
  { scope: ["markup.italic"], style: { foreground: DARK_TOKENS.emph, italic: true } },
  { scope: ["markup.raw.inline"], style: { foreground: DARK_TOKENS.codeInline } },
  { scope: ["markup.raw", "markup.raw.block"], style: { foreground: DARK_TOKENS.codeBlock } },
  { scope: ["markup.link.url"], style: { foreground: DARK_TOKENS.link, underline: true } },
  { scope: ["markup.link", "markup.link.label"], style: { foreground: DARK_TOKENS.link } },
  { scope: ["markup.list"], style: { foreground: DARK_TOKENS.accent } },
  { scope: ["markup.quote"], style: { foreground: DARK_TOKENS.muted, italic: true } },
  { scope: ["keyword"], style: { foreground: DARK_TOKENS.keyword } },
  { scope: ["string"], style: { foreground: DARK_TOKENS.string } },
  { scope: ["comment"], style: { foreground: DARK_TOKENS.comment, italic: true } },
  { scope: ["function"], style: { foreground: DARK_TOKENS.func } },
  { scope: ["number"], style: { foreground: DARK_TOKENS.number } },
  { scope: ["type"], style: { foreground: DARK_TOKENS.type } },
])
