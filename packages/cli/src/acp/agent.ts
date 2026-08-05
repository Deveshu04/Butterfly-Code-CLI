import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import {
  bashTool,
  buildSystem,
  createMcpTool,
  createMemoryTool,
  createSkillTool,
  createSnapshot,
  createTaskTool,
  DEFAULT_MAX_STEPS,
  EpisodicIndex,
  editTool,
  frecencyStorePath,
  globTool,
  grepTool,
  type ImageRef,
  listUntracked,
  loadConfig,
  loadMemory,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  McpHub,
  type McpServerConfig,
  memoryPaths,
  type PermissionDecision,
  type PermissionRules,
  type ProviderPort,
  type RunnerEvent,
  readTool,
  runUserTurn,
  SessionJournal,
  skillsIndex,
  ToolRegistry,
  type TurnOutcome,
  todoTool,
  withFrecencyTouch,
} from "@butterfly/core"
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcError,
  JsonRpcPeer,
} from "./jsonrpc"
import {
  ACP_AUTH_REQUIRED,
  ACP_SESSION_BUSY,
  type AgentInfo,
  type ContentBlock,
  type McpServerConfigAcp,
  type PermissionOption,
  PROTOCOL_VERSION,
  parseInitializeParams,
  parseRequestPermissionResult,
  parseSessionCancelParams,
  parseSessionNewParams,
  parseSessionPromptParams,
  type SessionUpdate,
  type StopReason,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolKind,
} from "./types"

interface AskRequest {
  tool: string
  target?: string
  note?: string
  input: unknown
}

const DEFAULT_RULES: PermissionRules = {
  "*": "allow",
  bash: "ask",
  edit: { "*": "ask", "**/.env*": "deny", ".env*": "deny" },
  web: "ask",
}

const PERMISSION_TIMEOUT_MS = 120_000

export interface AcpAgentOptions {
  /** Single provider instance shared by every session (mirrors run.ts). */
  provider: ProviderPort
  model?: string
  /** Home directory for config/memory/skills resolution. */
  home: string
  agentInfo?: AgentInfo
  /** Override for `PERMISSION_TIMEOUT_MS` (tests use a short one). */
  permissionTimeoutMs?: number
  onLog?: (message: string) => void
  mcpConnect?: (configs: Record<string, McpServerConfig>) => Promise<McpHub>
}

interface AcpSession {
  id: string
  cwd: string
  journal: SessionJournal
  registry: ToolRegistry
  rules: PermissionRules
  model: string
  system: string
  state: Record<string, unknown>
  episodic: EpisodicIndex
  pendingCalls: Map<string, { name: string; input: unknown }>
  abortController?: AbortController
  /** Connected MCP servers for this session (client-supplied + config). */
  mcpHub?: McpHub
}

function toHubConfigs(
  servers: McpServerConfigAcp[],
  log: (message: string) => void,
): Record<string, McpServerConfig> {
  const pairs = (list: { name: string; value: string }[] | undefined) =>
    list && list.length > 0
      ? Object.fromEntries(list.map((entry) => [entry.name, entry.value]))
      : undefined
  const configs: Record<string, McpServerConfig> = {}
  for (const server of servers) {
    if (server.command) {
      configs[server.name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(pairs(server.env) ? { env: pairs(server.env) } : {}),
      }
    } else if (server.url) {
      configs[server.name] = {
        url: server.url,
        ...(pairs(server.headers) ? { headers: pairs(server.headers) } : {}),
      }
    } else {
      log(`mcp server "${server.name}" has neither command nor url — skipped`)
    }
  }
  return configs
}

const TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  bash: "execute",
  glob: "search",
  grep: "search",
  todo: "think",
  task: "think",
  memory: "other",
  skill: "other",
}

function toolKind(name: string): ToolKind {
  return TOOL_KINDS[name] ?? "other"
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function toolCallTitle(name: string, input: unknown): string {
  const rec = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
  switch (name) {
    case "bash":
      return truncate(`Run: ${String(rec.command ?? "")}`, 100)
    case "edit":
      return `Edit ${String(rec.file_path ?? "")}`
    case "read":
      return `Read ${String(rec.file_path ?? "")}`
    case "glob":
      return `Find files: ${String(rec.pattern ?? "")}`
    case "grep":
      return truncate(`Search: ${String(rec.pattern ?? "")}`, 100)
    case "todo":
      return "Update plan"
    case "task":
      return truncate(`Subagent: ${String(rec.task ?? "")}`, 100)
    case "memory":
      return `Memory: ${String(rec.op ?? "")}`
    case "skill":
      return `Skill: ${String(rec.name ?? "index")}`
    default:
      return name
  }
}

function absolutePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"))
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new Error("aborted"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolvePromise(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        rejectPromise(error)
      },
    )
  })
}

function withRuleDecision(
  rules: PermissionRules,
  tool: string,
  target: string | undefined,
  decision: PermissionDecision,
): PermissionRules {
  if (target === undefined) return { ...rules, [tool]: decision }
  const existing = rules[tool]
  const patternMap = typeof existing === "object" && existing !== null ? existing : {}
  return { ...rules, [tool]: { ...patternMap, [target]: decision } }
}

export class AcpAgent {
  /** Set immediately after construction by `connectAcpAgent` — never used before then. */
  peer!: JsonRpcPeer
  private readonly sessions = new Map<string, AcpSession>()
  /** Turns currently running, so `shutdown` can wait for them to unwind. */
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(private readonly opts: AcpAgentOptions) {}

  /** stderr by default — stdout carries protocol frames and nothing else. */
  private log(message: string): void {
    if (this.opts.onLog) this.opts.onLog(message)
    else process.stderr.write(`acp: ${message}\n`)
  }

  async shutdown(reason = "client disconnected"): Promise<void> {
    this.peer?.abandonAll(reason)
    for (const session of this.sessions.values()) session.abortController?.abort()
    await Promise.allSettled([...this.inFlight])
    await Promise.allSettled([...this.sessions.values()].map((session) => session.mcpHub?.close()))
  }

  async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.handleInitialize(params)
      case "session/new":
        return this.handleSessionNew(params)
      case "session/prompt":
        return this.handleSessionPrompt(params)
      default:
        throw new JsonRpcError(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  }

  onNotification(method: string, params: unknown): void {
    if (method === "session/cancel") {
      this.handleSessionCancel(params)
    }
  }

  private handleInitialize(rawParams: unknown): unknown {
    const parsed = parseInitializeParams(rawParams)
    if (!parsed.ok) throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, parsed.message)
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        // McpHub speaks stdio (mandatory) + streamable HTTP; no legacy SSE.
        mcpCapabilities: { http: true, sse: false },
      },
      agentInfo: this.opts.agentInfo ?? { name: "butterfly", title: "Butterfly Code" },
      authMethods: [],
    }
  }

  private async handleSessionNew(rawParams: unknown): Promise<{ sessionId: string }> {
    const parsed = parseSessionNewParams(rawParams)
    if (!parsed.ok) throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, parsed.message)
    const cwd = resolve(parsed.data.cwd)
    const home = this.opts.home
    const config = loadConfig({ cwd, home })
    const modelRef = this.opts.model ?? config.model
    if (!modelRef) {
      throw new JsonRpcError(ACP_AUTH_REQUIRED, "No model configured", {
        authMethods: [
          {
            id: "config",
            name: "Run butterfly setup",
            description:
              'No provider/model configured — run "butterfly setup" or set "model" in butterfly.jsonc.',
          },
        ],
      })
    }

    const mcpConfigs = {
      ...(config.mcp ?? {}),
      ...toHubConfigs(parsed.data.mcpServers, (message) => this.log(message)),
    }
    let mcpHub: McpHub | undefined
    if (Object.keys(mcpConfigs).length > 0) {
      const connect = this.opts.mcpConnect ?? ((configs) => McpHub.connect(configs))
      mcpHub = await connect(mcpConfigs).catch((error: unknown) => {
        this.log(`mcp connect failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      for (const server of mcpHub?.status() ?? []) {
        this.log(
          server.error
            ? `mcp "${server.name}" unavailable — ${server.error}`
            : `mcp "${server.name}" connected — ${server.toolCount} tools (lazy: ${mcpHub?.indexTokens() ?? 0} index tokens vs ${mcpHub?.eagerTokens() ?? 0} eager)`,
        )
      }
    }

    const sessionId = `sess_${randomUUID()}`
    const sessionsDir = join(cwd, ".butterfly", "sessions")
    const journal = SessionJournal.create(sessionsDir)
    const episodic = EpisodicIndex.open(join(cwd, ".butterfly", "index.db"))
    const registry = this.buildRegistry(cwd, home, modelRef, sessionsDir, episodic, mcpHub)
    const memory = loadMemory(memoryPaths(cwd, home))
    const skillDirs = [
      join(cwd, ".butterfly", "skills"),
      join(home, ".config", "butterfly", "skills"),
    ]
    const system = buildSystem(modelRef, {
      cwd,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      projectMemory: memory.project,
      userMemory: memory.user,
      skillsIndex: skillsIndex(skillDirs),
    })

    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      journal,
      registry,
      rules: config.permissions ?? DEFAULT_RULES,
      model: modelRef,
      system,
      state: {},
      episodic,
      pendingCalls: new Map(),
      ...(mcpHub ? { mcpHub } : {}),
    })
    return { sessionId }
  }

  private buildRegistry(
    cwd: string,
    home: string,
    modelRef: string,
    sessionsDir: string,
    episodic: EpisodicIndex,
    mcpHub: McpHub | undefined,
  ): ToolRegistry {
    const registry = new ToolRegistry()
    const frecencyStore = frecencyStorePath(cwd)
    registry.register(bashTool)
    registry.register(withFrecencyTouch(readTool, frecencyStore, (input) => input.file_path))
    registry.register(withFrecencyTouch(editTool, frecencyStore, (input) => input.file_path))
    registry.register(globTool)
    registry.register(grepTool)
    registry.register(todoTool)
    registry.register(createMemoryTool({ paths: memoryPaths(cwd, home), episodic: () => episodic }))
    const skillDirs = [
      join(cwd, ".butterfly", "skills"),
      join(home, ".config", "butterfly", "skills"),
    ]
    registry.register(createSkillTool({ dirs: skillDirs }))
    registry.register(
      createTaskTool({
        provider: () => this.opts.provider,
        model: () => modelRef,
        system: (m) =>
          buildSystem(m, {
            cwd,
            platform: process.platform,
            date: new Date().toISOString().slice(0, 10),
          }),
        cwd,
        sessionsDir,
        makeRegistry: () => {
          const sub = new ToolRegistry()
          sub.register(readTool)
          sub.register(globTool)
          sub.register(grepTool)
          return sub
        },
      }),
    )
    if (mcpHub) registry.register(createMcpTool({ hub: () => mcpHub }))
    return registry
  }

  private handleSessionCancel(rawParams: unknown): void {
    const parsed = parseSessionCancelParams(rawParams)
    if (!parsed.ok) return // malformed cancel — nothing addressable, nothing to report (notification)
    const session = this.sessions.get(parsed.data.sessionId)
    session?.abortController?.abort()
  }

  private async handleSessionPrompt(rawParams: unknown): Promise<{ stopReason: StopReason }> {
    const parsed = parseSessionPromptParams(rawParams)
    if (!parsed.ok) throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, parsed.message)
    const session = this.sessions.get(parsed.data.sessionId)
    if (!session) {
      throw new JsonRpcError(
        JSON_RPC_INVALID_PARAMS,
        `Unknown sessionId "${parsed.data.sessionId}"`,
      )
    }
    if (session.abortController) {
      throw new JsonRpcError(
        ACP_SESSION_BUSY,
        `Session "${session.id}" is already processing a prompt — await its response, or send session/cancel first.`,
        { sessionId: session.id },
      )
    }

    const { text, images } = this.flattenPrompt(parsed.data.prompt, session.cwd)
    const abortController = new AbortController()
    session.abortController = abortController
    session.pendingCalls.clear()

    const turn = this.runTurn(session, text, images, abortController)
    this.inFlight.add(turn)
    try {
      return await turn
    } finally {
      this.inFlight.delete(turn)
    }
  }

  private async runTurn(
    session: AcpSession,
    text: string,
    images: ImageRef[],
    abortController: AbortController,
  ): Promise<{ stopReason: StopReason }> {
    const timeoutMs = this.opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS

    const ask = async (request: AskRequest): Promise<"allow" | "deny"> => {
      const front = session.pendingCalls.keys().next()
      const toolCallId = front.done ? `call_${randomUUID()}` : front.value
      const options: PermissionOption[] = [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: `Always allow ${request.tool}`, kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        { optionId: "reject-always", name: `Never allow ${request.tool}`, kind: "reject_always" },
      ]
      const { id, promise } = this.peer.requestWithId("session/request_permission", {
        sessionId: session.id,
        toolCall: { toolCallId },
        options,
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      const answered = Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`permission request timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        }),
      ])
      answered.catch(() => {})
      try {
        const raw = await raceAbort(answered, abortController.signal)
        const parsedOutcome = parseRequestPermissionResult(raw)
        if (!parsedOutcome.ok) {
          this.log(`auto-denied ${request.tool} — malformed session/request_permission result`)
          return "deny"
        }
        const { outcome } = parsedOutcome.data
        if (outcome.outcome === "cancelled") return "deny"
        switch (outcome.optionId) {
          case "allow-once":
            return "allow"
          case "allow-always":
            session.rules = withRuleDecision(session.rules, request.tool, request.target, "allow")
            return "allow"
          case "reject-always":
            session.rules = withRuleDecision(session.rules, request.tool, request.target, "deny")
            return "deny"
          default:
            return "deny"
        }
      } catch (error) {
        this.peer.abandon(id, "permission request abandoned") // no-op if already answered
        this.log(
          `auto-denied ${request.tool}${request.target ? ` on "${request.target}"` : ""} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        return "deny"
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const onEvent = (event: RunnerEvent): void => this.translateEvent(session, event)

    let outcome: TurnOutcome | undefined
    let thrown: unknown
    try {
      outcome = await runUserTurn(
        {
          provider: this.opts.provider,
          registry: session.registry,
          journal: session.journal,
          rules: session.rules,
          model: session.model,
          system: session.system,
          cwd: session.cwd,
          ask,
          state: session.state,
          createSnapshot,
          listUntracked,
          signal: abortController.signal,
          onEvent,
        },
        text,
        images.length > 0 ? { images } : undefined,
      )
    } catch (error) {
      thrown = error
    } finally {
      session.abortController = undefined
      session.pendingCalls.clear()
    }

    try {
      session.episodic.indexJournal(session.journal.path)
    } catch {
      // best-effort — never fail the turn's response over indexing
    }

    if (abortController.signal.aborted) return { stopReason: "cancelled" }
    if (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown)
      throw new JsonRpcError(JSON_RPC_INTERNAL_ERROR, message)
    }
    if (!outcome) throw new JsonRpcError(JSON_RPC_INTERNAL_ERROR, "Turn produced no outcome")
    if (outcome.budgetExceeded) return { stopReason: "max_tokens" }
    if (outcome.steps >= DEFAULT_MAX_STEPS) return { stopReason: "max_turn_requests" }
    return { stopReason: "end_turn" }
  }

  private flattenPrompt(blocks: ContentBlock[], cwd: string): { text: string; images: ImageRef[] } {
    const parts: string[] = []
    const images: ImageRef[] = []
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          parts.push(block.text)
          break
        case "resource":
          if ("text" in block.resource) {
            parts.push(`\`\`\`${block.resource.uri}\n${block.resource.text}\n\`\`\``)
          } else {
            parts.push(`[embedded resource ${block.resource.uri} — binary content omitted]`)
          }
          break
        case "resource_link":
          parts.push(`[${block.name ?? block.uri}](${block.uri})`)
          break
        case "image": {
          if (images.length >= MAX_IMAGES_PER_TURN) {
            parts.push("[image attachment skipped — max images per turn reached]")
            break
          }
          const ref = this.materializeImage(block, cwd)
          if (ref) images.push(ref)
          else parts.push("[image attachment could not be saved]")
          break
        }
        case "audio":
          parts.push("[audio attachment not supported]")
          break
        default:
          break
      }
    }
    return { text: parts.join("\n\n"), images }
  }

  private materializeImage(
    block: { mimeType: string; data: string },
    cwd: string,
  ): ImageRef | undefined {
    let bytes: Buffer
    try {
      bytes = Buffer.from(block.data, "base64")
    } catch {
      return undefined
    }
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(bytes)
    const hash = hasher.digest("hex")
    const dir = join(cwd, ".butterfly", "acp-attachments")
    try {
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${hash}.bin`)
      writeFileSync(path, bytes)
      return { path, mediaType: block.mimeType, sha256: hash }
    } catch {
      return undefined
    }
  }

  private translateEvent(session: AcpSession, event: RunnerEvent): void {
    switch (event.type) {
      case "text-delta":
        if (event.text !== "") {
          this.sendUpdate(session, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.text },
          })
        }
        break
      case "reasoning-delta":
        if (event.text !== "") {
          this.sendUpdate(session, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.text },
          })
        }
        break
      case "tool-call":
        session.pendingCalls.set(event.callId, { name: event.name, input: event.input })
        this.sendUpdate(session, {
          sessionUpdate: "tool_call",
          toolCallId: event.callId,
          title: toolCallTitle(event.name, event.input),
          kind: toolKind(event.name),
          status: "pending",
          rawInput: event.input,
        })
        this.sendUpdate(session, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.callId,
          status: "in_progress",
        })
        break
      case "tool-result": {
        const pending = session.pendingCalls.get(event.callId)
        session.pendingCalls.delete(event.callId)
        const content = this.toolCallContent(event, pending, session.cwd)
        const locations = this.toolCallLocations(pending, session.cwd)
        this.sendUpdate(session, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.callId,
          status: event.isError ? "failed" : "completed",
          ...(content.length > 0 ? { content } : {}),
          ...(locations.length > 0 ? { locations } : {}),
        })
        if (event.name === "todo" && !event.isError && pending) {
          const input = pending.input as { items?: { text: string; status: string }[] }
          if (Array.isArray(input.items)) {
            this.sendUpdate(session, {
              sessionUpdate: "plan",
              entries: input.items.map((item) => ({
                content: item.text,
                priority: "medium" as const,
                status: item.status as "pending" | "in_progress" | "completed",
              })),
            })
          }
        }
        break
      }
      default:
        break
    }
  }

  private toolCallContent(
    event: Extract<RunnerEvent, { type: "tool-result" }>,
    pending: { name: string; input: unknown } | undefined,
    cwd: string,
  ): ToolCallContent[] {
    if (event.name === "edit" && pending) {
      const input = pending.input as {
        file_path?: string
        old_string?: string
        new_string?: string
      }
      if (typeof input.file_path === "string" && typeof input.new_string === "string") {
        return [
          {
            type: "diff",
            path: absolutePath(cwd, input.file_path),
            oldText:
              input.old_string === "" || input.old_string === undefined ? null : input.old_string,
            newText: input.new_string,
          },
        ]
      }
    }
    if (event.output.trim() === "") return []
    return [{ type: "content", content: { type: "text", text: event.output } }]
  }

  private toolCallLocations(
    pending: { name: string; input: unknown } | undefined,
    cwd: string,
  ): ToolCallLocation[] {
    if (!pending) return []
    const input = pending.input as Record<string, unknown>
    const rawPath = typeof input.file_path === "string" ? input.file_path : undefined
    if (!rawPath) return []
    return [{ path: absolutePath(cwd, rawPath) }]
  }

  private sendUpdate(session: AcpSession, update: SessionUpdate): void {
    this.peer.notify("session/update", { sessionId: session.id, update })
  }
}

/**
 * Construct an AcpAgent and wire it to a fresh JsonRpcPeer over `send`. Both
 * come back: the peer to feed lines into, the agent so the caller can
 * `shutdown()` it when the client's stream ends.
 */
export function connectAcpAgent(
  send: (line: string) => void,
  opts: AcpAgentOptions,
): { peer: JsonRpcPeer; agent: AcpAgent } {
  const agent = new AcpAgent(opts)
  const peer = new JsonRpcPeer({
    send,
    onRequest: (method, params) => agent.onRequest(method, params),
    onNotification: (method, params) => agent.onNotification(method, params),
  })
  agent.peer = peer
  return { peer, agent }
}
