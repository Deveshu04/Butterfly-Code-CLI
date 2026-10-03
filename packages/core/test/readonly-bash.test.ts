import { expect, test } from "bun:test"
import { z } from "zod"
import { isProvablyReadOnly, tokenizeSafe } from "../src/permission/readonly-bash"
import { resolvePermissionWithSource } from "../src/permission/tree"
import { type AskRequest, type ToolContext, ToolRegistry } from "../src/tool/registry"
import { bashTool } from "../src/tool/tools/bash"

test("plain read-only commands and pipelines are proven", () => {
  for (const command of [
    "ls -la",
    "git status",
    "git --no-pager log --oneline -20",
    "git diff HEAD~1 -- src/a.ts",
    "rg -n 'TODO|FIXME' src | head -50",
    "cat package.json && wc -l src/*.ts",
    "find . -name '*.ts' -not -path './node_modules/*'",
    'grep -rn "export function" packages/core/src',
    "git branch -a; git remote -v",
    "sort names.txt | uniq -c",
    "pwd",
  ]) {
    expect({ command, ok: isProvablyReadOnly(command) }).toEqual({ command, ok: true })
  }
})

test("anything that can write, execute, expand or redirect is NOT proven", () => {
  for (const command of [
    "rm -rf build",
    "ls > out.txt",
    "cat a 2>/dev/null",
    "echo $(whoami)",
    "echo `id`",
    'echo "$HOME"',
    "ls $HOME",
    "find . -name x -delete",
    "find . -exec rm {} ;",
    "rg --pre ./evil.sh foo",
    "sort -o out.txt in.txt",
    "sort -uo out.txt in.txt",
    "uniq in.txt out.txt",
    "git -c core.pager=evil log",
    "git log --output=x",
    "git diff --ext-diff",
    "git branch new-feature",
    "git checkout main",
    "git push",
    "git stash",
    "git grep -O foo",
    "npm test",
    "ls &",
    "(ls)",
    "ls\nrm -rf /",
    "cat .env",
    "head -5 config/.env.local",
    "FOO=1 ls",
    "ls |",
    "| ls",
    "ls && && pwd",
    "'rm' -rf x",
    "file -C -m magic",
    "",
  ]) {
    expect({ command, ok: isProvablyReadOnly(command) }).toEqual({ command, ok: false })
  }
})

test("the tokenizer keeps quoted text literal and refuses unterminated quotes", () => {
  expect(tokenizeSafe("grep 'a b' \"c d\"")).toEqual([
    { kind: "word", value: "grep" },
    { kind: "word", value: "a b" },
    { kind: "word", value: "c d" },
  ])
  expect(tokenizeSafe("echo 'oops")).toBeUndefined()
})

test("permission source: only blanket rules count as blanket", () => {
  expect(resolvePermissionWithSource({ bash: "ask" }, "bash", "ls")).toEqual({
    decision: "ask",
    blanket: true,
  })
  expect(resolvePermissionWithSource({ "*": "ask" }, "bash", "ls")).toEqual({
    decision: "ask",
    blanket: true,
  })
  expect(resolvePermissionWithSource({ bash: { "*": "ask" } }, "bash", "ls")).toEqual({
    decision: "ask",
    blanket: true,
  })
  expect(
    resolvePermissionWithSource({ bash: { "*": "allow", "git *": "ask" } }, "bash", "git status"),
  ).toEqual({
    decision: "ask",
    blanket: false,
  })
})

function ctx(
  rules: ToolContext["rules"],
  asked: AskRequest[],
  extra: Partial<ToolContext> = {},
): ToolContext {
  return {
    cwd: process.cwd(),
    rules,
    state: {},
    ask: async (request) => {
      asked.push(request)
      return "deny"
    },
    ...extra,
  }
}

function registry() {
  const r = new ToolRegistry()
  r.register(bashTool)
  return r
}

test("a provably read-only command skips a blanket ask; anything else still asks", async () => {
  const asked: AskRequest[] = []
  const ok = await registry().run(
    "bash",
    { command: "pwd" },
    ctx({ "*": "allow", bash: "ask" }, asked),
  )
  expect(ok.isError).toBe(false)
  expect(asked).toEqual([])
  const denied = await registry().run("bash", { command: "touch x" }, ctx({ bash: "ask" }, asked))
  expect(denied.isError).toBe(true)
  expect(asked.map((a) => a.target)).toEqual(["touch x"])
})

test("explicit user patterns, denies, background runs and the opt-out all win", async () => {
  const asked: AskRequest[] = []
  await registry().run(
    "bash",
    { command: "git status" },
    ctx({ bash: { "*": "allow", "git *": "ask" } }, asked),
  )
  await registry().run(
    "bash",
    { command: "pwd" },
    ctx({ bash: "ask" }, asked, { autoApproveReadOnly: false }),
  )
  await registry().run("bash", { command: "ls", background: true }, ctx({ bash: "ask" }, asked))
  expect(asked.map((a) => a.target)).toEqual(["git status", "pwd", "ls"])
  const policy = await registry().run("bash", { command: "pwd" }, ctx({ bash: "deny" }, asked))
  expect(policy.output).toContain("Permission denied")
})

test("generic tools without autoAllow are unaffected", async () => {
  const asked: AskRequest[] = []
  const r = new ToolRegistry()
  r.register({
    name: "x",
    description: "x",
    inputSchema: z.object({}),
    execute: async () => ({ output: "ran" }),
  })
  await r.run("x", {}, ctx({ "*": "ask" }, asked))
  expect(asked.length).toBe(1)
})
