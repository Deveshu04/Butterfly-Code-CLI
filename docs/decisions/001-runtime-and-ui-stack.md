# 001: TypeScript on Bun, with an OpenTUI + SolidJS terminal UI

Status: accepted

## Context

A coding agent needs fast iteration on the harness, first-class SDKs for model
providers and MCP, tree-sitter parsing, an embedded database, and a polished
full-screen terminal UI that works on Windows, macOS and Linux.

## Options

1. **TypeScript on Bun**, one codebase for engine and UI.
2. **Rust**: fast single binary, but slower iteration and thinner AI SDKs.
3. **Go**: good binaries and TUI libraries, thinner AI and MCP ecosystem.
4. **TypeScript engine with a TUI in another language**: two codebases and an
   IPC layer to keep in sync.

## Decision

Option 1. The UI is built with OpenTUI (`@opentui/core` + `@opentui/solid`).

## Rationale

- The richest ecosystem for this domain: the AI SDK, the official MCP SDK,
  tree-sitter compiled to WebAssembly.
- `bun:sqlite` is built in, which removes a whole class of native-dependency
  problems; `bun build --compile` produces single-file binaries.
- One language for engine and UI avoids a split codebase and an IPC protocol.

## Consequences

- Platform support follows Bun's.
- Hot paths (parsing, ranking) must be measured; the escape hatch is a native
  module, not a rewrite.
