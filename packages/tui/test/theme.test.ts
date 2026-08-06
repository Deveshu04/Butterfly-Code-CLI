import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ANSI_COLOR_NAMES,
  applyOverrides,
  builtinTheme,
  DARK_TOKENS,
  isAnsiSafeTheme,
  LIGHT_TOKENS,
  listThemeNames,
  loadCustomThemes,
  resolveTheme,
  setThemeTokens,
  themeTokens,
} from "../src/theme"

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "bfly-theme-"))
}

test("DARK_TOKENS pins the default palette", () => {
  expect(DARK_TOKENS.muted).toBe("#8b8b8b")
  expect(DARK_TOKENS.accent).toBe("#c9a7ff")
  expect(DARK_TOKENS.error).toBe("#ff8080")
  expect(DARK_TOKENS.warn).toBe("#ffcc66")
  expect(DARK_TOKENS.fg).toBe("#e8e8e8")
  expect(DARK_TOKENS.heading).toBe("#ffffff")
  expect(DARK_TOKENS.strong).toBe("#ffffff")
  expect(DARK_TOKENS.emph).toBe("#d8d8d8")
  expect(DARK_TOKENS.codeInline).toBe("#a8d7a8")
  expect(DARK_TOKENS.codeBlock).toBe("#c8e0c8")
  expect(DARK_TOKENS.link).toBe("#8ab4ff")
  expect(DARK_TOKENS.keyword).toBe("#c586c0")
  expect(DARK_TOKENS.string).toBe("#ce9178")
  expect(DARK_TOKENS.comment).toBe("#6a9955")
  expect(DARK_TOKENS.func).toBe("#dcdcaa")
  expect(DARK_TOKENS.number).toBe("#b5cea8")
  expect(DARK_TOKENS.type).toBe("#4ec9b0")
  expect(DARK_TOKENS.diffAdd).toBe("#22c55e")
  expect(DARK_TOKENS.diffDel).toBe("#ef4444")
  expect(DARK_TOKENS.diffAddBg).toBe("#1a4d1a")
  expect(DARK_TOKENS.diffDelBg).toBe("#4d1a1a")
  expect(DARK_TOKENS.diffLineNumber).toBe("#888888")
  expect(DARK_TOKENS.diffContextBg).toBe("transparent")
  expect(DARK_TOKENS.diffLineNumberBg).toBe("transparent")
})

test("applyOverrides resolves known keys and silently ignores unknown/malformed ones", () => {
  const result = applyOverrides(DARK_TOKENS, {
    accent: "#ff00ff",
    bogusTypo: "#123456",
    warn: 42,
  })
  expect(result.accent).toBe("#ff00ff")
  expect(result.warn).toBe(DARK_TOKENS.warn)
  expect((result as unknown as Record<string, unknown>).bogusTypo).toBeUndefined()
  expect(DARK_TOKENS.accent).toBe("#c9a7ff")
})

test("applyOverrides with no overrides returns the base unchanged", () => {
  expect(applyOverrides(DARK_TOKENS)).toEqual(DARK_TOKENS)
})

test("resolveTheme resolves builtins directly and custom files via base+overrides", () => {
  expect(resolveTheme("dark", {})).toEqual(DARK_TOKENS)
  const custom = { ocean: { base: "dark", overrides: { accent: "#00aaff" } } }
  const resolved = resolveTheme("ocean", custom)
  expect(resolved.accent).toBe("#00aaff")
  expect(resolved.muted).toBe(DARK_TOKENS.muted)
  // an unresolvable name falls back to dark rather than throwing
  expect(resolveTheme("does-not-exist", {})).toEqual(DARK_TOKENS)
  // a custom file with no base defaults to dark
  expect(resolveTheme("noBase", { noBase: { overrides: { warn: "#111111" } } }).warn).toBe(
    "#111111",
  )
})

test("dark-ansi and light-ansi presets are ansi-safe; the truecolor builtins are not", () => {
  expect(isAnsiSafeTheme(builtinTheme("dark-ansi"))).toBe(true)
  expect(isAnsiSafeTheme(builtinTheme("light-ansi"))).toBe(true)
  expect(isAnsiSafeTheme(DARK_TOKENS)).toBe(false)
  expect(isAnsiSafeTheme(LIGHT_TOKENS)).toBe(false)
})

test("every non-background ansi-preset token is one of the 16 canonical ANSI names", () => {
  expect(ANSI_COLOR_NAMES.length).toBe(16)
  for (const name of ["dark-ansi", "light-ansi"] as const) {
    const preset = builtinTheme(name)
    for (const value of Object.values(preset)) {
      if (value === "transparent") continue
      expect(ANSI_COLOR_NAMES as readonly string[]).toContain(value)
    }
  }
})

test("loadCustomThemes reads *.json theme files and fails soft on a malformed one", () => {
  const home = tempHome()
  const dir = join(home, ".config", "butterfly", "themes")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "ocean.json"),
    JSON.stringify({ base: "dark", overrides: { accent: "#00aaff", nonsense: "#000000" } }),
  )
  writeFileSync(join(dir, "broken.json"), "{ not valid json")
  writeFileSync(join(dir, "not-a-theme.txt"), "ignored — wrong extension")
  const themes = loadCustomThemes(home)
  expect(Object.keys(themes)).toEqual(["ocean"])
  expect(themes.ocean?.base).toBe("dark")
  expect(themes.ocean?.overrides?.accent).toBe("#00aaff")
})

test("loadCustomThemes returns {} when the themes dir doesn't exist — never throws", () => {
  expect(loadCustomThemes(tempHome())).toEqual({})
})

test("listThemeNames merges the 4 builtins with custom theme files, sorted", () => {
  const home = tempHome()
  const dir = join(home, ".config", "butterfly", "themes")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "ocean.json"), JSON.stringify({ base: "dark" }))
  expect(listThemeNames(home)).toEqual(["dark", "dark-ansi", "light", "light-ansi", "ocean"])
})

test("the reactive store starts on DARK_TOKENS and reflects setThemeTokens", () => {
  setThemeTokens(DARK_TOKENS) // reset in case test order left it mutated
  expect(themeTokens()).toEqual(DARK_TOKENS)
  const light = resolveTheme("light", {})
  setThemeTokens(light)
  expect(themeTokens()).toEqual(light)
  setThemeTokens(DARK_TOKENS) // leave clean for later tests in this process
})
