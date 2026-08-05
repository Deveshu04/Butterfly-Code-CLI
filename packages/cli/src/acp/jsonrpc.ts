
export type JsonRpcId = number | string

export interface JsonRpcErrorShape {
  code: number
  message: string
  data?: unknown
}

export const JSON_RPC_PARSE_ERROR = -32700
export const JSON_RPC_INVALID_REQUEST = -32600
export const JSON_RPC_METHOD_NOT_FOUND = -32601
export const JSON_RPC_INVALID_PARAMS = -32602
export const JSON_RPC_INTERNAL_ERROR = -32603

export class JsonRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "JsonRpcError"
    this.code = code
    this.data = data
  }
}

export interface JsonRpcPeerOptions {
  /** Write one already-terminated frame to the wire (peer appends the `\n`). */
  send: (line: string) => void
  /** Handle an incoming request; throw JsonRpcError for a typed wire error. */
  onRequest: (method: string, params: unknown) => Promise<unknown>
  /** Handle an incoming notification. Never produces a wire response. */
  onNotification: (method: string, params: unknown) => void
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: JsonRpcError) => void
}

export class JsonRpcPeer {
  private nextId = 0
  private readonly pending = new Map<JsonRpcId, PendingCall>()

  constructor(private readonly opts: JsonRpcPeerOptions) {}

  /** Feed one already-split line of input (no trailing newline expected). */
  async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (trimmed === "") return
    let msg: unknown
    try {
      msg = JSON.parse(trimmed)
    } catch {
      this.writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error" },
      })
      return
    }
    await this.handleMessage(msg)
  }

  /** Send a request to the peer (e.g. Agent→Client `session/request_permission`). */
  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.writeMessage({
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      })
    })
  }

  /** Send a notification — no response is expected, ever (e.g. `session/update`). */
  notify(method: string, params?: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request" },
      })
      return
    }
    const obj = msg as Record<string, unknown>

    if (typeof obj.method === "string") {
      const hasId = "id" in obj && obj.id !== undefined
      if (hasId) {
        await this.handleRequest(obj.id as JsonRpcId, obj.method, obj.params)
      } else {
        try {
          this.opts.onNotification(obj.method, obj.params)
        } catch {
          // Notifications never get a wire response — swallow handler errors.
        }
      }
      return
    }

    if ("id" in obj) {
      this.handleResponse(obj)
      return
    }

    this.writeMessage({
      jsonrpc: "2.0",
      id: (obj.id as JsonRpcId | undefined) ?? null,
      error: { code: JSON_RPC_INVALID_REQUEST, message: "Invalid Request" },
    })
  }

  private async handleRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.opts.onRequest(method, params)
      this.writeMessage({ jsonrpc: "2.0", id, result: result === undefined ? null : result })
    } catch (error) {
      const err =
        error instanceof JsonRpcError
          ? error
          : new JsonRpcError(
              JSON_RPC_INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            )
      this.writeMessage({
        jsonrpc: "2.0",
        id,
        error: {
          code: err.code,
          message: err.message,
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
      })
    }
  }

  private handleResponse(obj: Record<string, unknown>): void {
    const id = obj.id as JsonRpcId
    const pending = this.pending.get(id)
    if (!pending) return // unmatched/late response — nothing to resolve, ignore per JSON-RPC leniency
    this.pending.delete(id)
    if ("error" in obj && obj.error !== undefined && obj.error !== null) {
      const e = obj.error as Partial<JsonRpcErrorShape>
      pending.reject(
        new JsonRpcError(
          typeof e.code === "number" ? e.code : JSON_RPC_INTERNAL_ERROR,
          typeof e.message === "string" ? e.message : "Unknown error",
          e.data,
        ),
      )
    } else {
      pending.resolve("result" in obj ? obj.result : undefined)
    }
  }

  private writeMessage(msg: unknown): void {
    this.opts.send(`${JSON.stringify(msg)}\n`)
  }
}
