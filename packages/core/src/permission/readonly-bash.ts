/**
 * Provably read-only shell commands, which can skip the approval prompt.
 * A command qualifies only if all of these hold:
 * - it tokenizes with no shell feature that can run or redirect anything:
 *   no `$` (expansion/substitution), backticks, redirections, subshells,
 *   braces, background `&`, backslash escapes, or newlines;
 * - it is simple commands joined by `|`, `||`, `&&` or `;` only;
 * - every command is on the allowlist below and passes its argument check
 *   (no `find -exec`, `rg --pre`, `sort -o`, `git -c`, `--output=`, …);
 * - no argument names a `.env` file (secrets stay behind an explicit ask).
 *
 * Anything else falls back to the normal permission decision.
 */

type Token = { kind: "word"; value: string } | { kind: "op"; value: string }

/** Shell tokenizer for the safe subset; undefined = contains something we refuse. */
export function tokenizeSafe(command: string): Token[] | undefined {
  const tokens: Token[] = []
  let word = ""
  let inWord = false
  let i = 0
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", value: word })
    word = ""
    inWord = false
  }
  while (i < command.length) {
    const char = command[i] as string
    if (char === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return undefined
      word += command.slice(i + 1, end)
      inWord = true
      i = end + 1
      continue
    }
    if (char === '"') {
      const end = command.indexOf('"', i + 1)
      if (end === -1) return undefined
      const body = command.slice(i + 1, end)
      if (/[$`\\]/.test(body)) return undefined
      word += body
      inWord = true
      i = end + 1
      continue
    }
    if (char === " " || char === "\t") {
      flush()
      i += 1
      continue
    }
    if (char === "|" || char === "&" || char === ";") {
      flush()
      const two = command.slice(i, i + 2)
      if (two === "||" || two === "&&") {
        tokens.push({ kind: "op", value: two })
        i += 2
        continue
      }
      if (char === "&") return undefined // background job
      tokens.push({ kind: "op", value: char })
      i += 1
      continue
    }
    if ("$`<>(){}\\\n\r!#".includes(char)) return undefined
    word += char
    inWord = true
    i += 1
  }
  flush()
  return tokens
}

/** Commands that only read, with an argument check where a flag could write or execute. */
const COMMANDS: Record<string, (args: string[]) => boolean> = {
  ls: () => true,
  pwd: () => true,
  cat: () => true,
  head: () => true,
  tail: () => true,
  wc: () => true,
  stat: () => true,
  du: () => true,
  df: () => true,
  which: () => true,
  echo: () => true,
  printf: () => true,
  true: () => true,
  basename: () => true,
  dirname: () => true,
  realpath: () => true,
  readlink: () => true,
  cut: () => true,
  tr: () => true,
  nl: () => true,
  diff: () => true,
  cmp: () => true,
  grep: () => true,
  egrep: () => true,
  fgrep: () => true,
  // Not jq: a single-quoted `$ENV.SECRET` filter prints the environment.
  // `file -C` compiles a magic file (writes magic.mgc).
  file: (args) => !args.some((a) => a === "-C" || a === "--compile"),
  tree: (args) => !args.some((a) => a === "-o" || a.startsWith("--output")),
  rg: (args) => !args.some((a) => a.startsWith("--pre")),
  // -o anywhere in a short-flag cluster (`-uo out`) writes a file.
  sort: (args) => !args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith("--output")),
  // `uniq IN OUT` writes OUT.
  uniq: (args) => args.filter((a) => !a.startsWith("-")).length <= 1,
  find: (args) =>
    !args.some((a) =>
      [
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-delete",
        "-fprint",
        "-fprint0",
        "-fprintf",
        "-fls",
      ].includes(a),
    ),
  git: gitReadOnly,
}

const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "ls-files",
  "rev-parse",
  "describe",
  "shortlog",
  "grep",
])
const GIT_BRANCH_FLAGS = new Set([
  "-a",
  "-r",
  "-v",
  "-vv",
  "--all",
  "--remotes",
  "--verbose",
  "--list",
  "--show-current",
  "--no-color",
])
/** Flags that write files or run configured programs, on any subcommand. */
const GIT_UNSAFE_ARG =
  /^(--output|--ext-diff|--textconv|--exec|--upload-pack|--config|--open-files-in-pager|-c$|-o$|-O)/

function gitReadOnly(args: string[]): boolean {
  let rest = args
  while (rest[0] === "--no-pager") rest = rest.slice(1)
  const [sub, ...subArgs] = rest
  if (sub === undefined || subArgs.some((a) => GIT_UNSAFE_ARG.test(a))) return false
  if (GIT_READ_SUBCOMMANDS.has(sub)) return true
  if (sub === "branch") return subArgs.every((a) => GIT_BRANCH_FLAGS.has(a))
  if (sub === "remote") return subArgs.every((a) => a === "-v" || a === "--verbose")
  if (sub === "tag") return subArgs.every((a) => a === "-l" || a === "--list")
  if (sub === "stash") return subArgs.length === 1 && subArgs[0] === "list"
  return false
}

const ENV_FILE = /(^|[\\/])\.env/

export function isProvablyReadOnly(command: string): boolean {
  const tokens = tokenizeSafe(command)
  if (!tokens || tokens.length === 0) return false
  const segments: string[][] = [[]]
  for (const token of tokens) {
    if (token.kind === "op") {
      if ((segments.at(-1) ?? []).length === 0) return false // leading/doubled operator
      segments.push([])
    } else {
      segments.at(-1)?.push(token.value)
    }
  }
  if ((segments.at(-1) ?? []).length === 0) return false // trailing operator
  return segments.every(([name, ...args]) => {
    if (name === undefined) return false
    const check = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
    if (!check) return false
    if (args.some((arg) => ENV_FILE.test(arg))) return false
    return check(args)
  })
}
