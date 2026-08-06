import { expect, test } from "bun:test"
import { APICallError, RetryError } from "ai"
import { classifyProviderError, describeProviderError } from "../src/provider/describe-error"


function apiCallError(opts: {
  message: string
  statusCode?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  data?: unknown
  isRetryable?: boolean
}): APICallError {
  return new APICallError({
    message: opts.message,
    url: "https://api.example.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    responseHeaders: opts.responseHeaders,
    responseBody: opts.responseBody,
    data: opts.data,
    isRetryable: opts.isRetryable ?? false,
  })
}


test("429 APICallError with Retry-After classifies as rate_limit with retryAfterSec", () => {
  const error = apiCallError({
    message: "Rate limit reached for requests",
    statusCode: 429,
    responseHeaders: { "retry-after": "30" },
    responseBody: JSON.stringify({
      error: {
        message: "Rate limit reached for requests",
        type: "requests",
        code: "rate_limit_exceeded",
      },
    }),
    data: {
      error: {
        message: "Rate limit reached for requests",
        type: "requests",
        code: "rate_limit_exceeded",
      },
    },
  })
  const info = classifyProviderError(error)
  expect(info.kind).toBe("rate_limit")
  expect(info.status).toBe(429)
  expect(info.retryAfterSec).toBe(30)
  expect(info.message).toBe("Rate limit reached for requests")
})

test("401 APICallError classifies as auth", () => {
  const error = apiCallError({
    message: "Incorrect API key provided",
    statusCode: 401,
    data: { error: { message: "Incorrect API key provided", type: "invalid_request_error" } },
  })
  const info = classifyProviderError(error)
  expect(info.kind).toBe("auth")
  expect(info.status).toBe(401)
})

test("403 APICallError classifies as auth", () => {
  const error = apiCallError({ message: "Forbidden", statusCode: 403 })
  expect(classifyProviderError(error).kind).toBe("auth")
})

test("402 APICallError classifies as quota", () => {
  const error = apiCallError({
    message: "You exceeded your current quota",
    statusCode: 402,
    data: { error: { message: "You exceeded your current quota", type: "insufficient_quota" } },
  })
  const info = classifyProviderError(error)
  expect(info.kind).toBe("quota")
  expect(info.status).toBe(402)
})

test("408 APICallError classifies as timeout", () => {
  const error = apiCallError({ message: "Request timed out", statusCode: 408 })
  expect(classifyProviderError(error).kind).toBe("timeout")
})

test("413 APICallError classifies as context_length", () => {
  const error = apiCallError({ message: "Payload too large", statusCode: 413 })
  expect(classifyProviderError(error).kind).toBe("context_length")
})

test("529 overloaded APICallError classifies as unavailable", () => {
  const error = apiCallError({
    message: "Overloaded",
    statusCode: 529,
    data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
  })
  const info = classifyProviderError(error)
  expect(info.kind).toBe("unavailable")
  expect(info.status).toBe(529)
})

test("500 APICallError classifies as unavailable", () => {
  const error = apiCallError({ message: "Internal server error", statusCode: 500 })
  expect(classifyProviderError(error).kind).toBe("unavailable")
})

test("a network-level APICallError (no statusCode, handleFetchError shape) classifies as network", () => {
  const error = apiCallError({
    message: "Cannot connect to API: ECONNREFUSED",
    isRetryable: true,
  })
  const info = classifyProviderError(error)
  expect(info.kind).toBe("network")
  expect(info.status).toBeUndefined()
})

test("429 APICallError with an insufficient_quota code classifies as quota, not rate_limit", () => {
  const error = apiCallError({
    message: "You exceeded your current quota",
    statusCode: 429,
    data: {
      error: {
        message: "You exceeded your current quota",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    },
  })
  expect(classifyProviderError(error).kind).toBe("quota")
})


test("RetryError unwraps to the last underlying error's classification", () => {
  const last = apiCallError({ message: "Rate limit reached", statusCode: 429 })
  const retry = new RetryError({
    message: "Failed after 3 attempts. Last error: Rate limit reached",
    reason: "maxRetriesExceeded",
    errors: [apiCallError({ message: "Rate limit reached", statusCode: 429 }), last],
  })
  const info = classifyProviderError(retry)
  expect(info.kind).toBe("rate_limit")
  expect(info.status).toBe(429)
})


test("plain-object OpenAI-shape body (no APICallError wrapper) classifies correctly", () => {
  const raw = {
    status: 429,
    error: {
      message: "Rate limit reached for gpt-4",
      type: "requests",
      code: "rate_limit_exceeded",
    },
  }
  const info = classifyProviderError(raw)
  expect(info.kind).toBe("rate_limit")
  expect(info.message).toBe("Rate limit reached for gpt-4")
  // detail is human-message-first with the deduped machine tags appended.
  expect(info.detail).toBe("Rate limit reached for gpt-4 (requests rate_limit_exceeded)")
})

test("plain-object Anthropic-shape body (no wrapper, no HTTP status) classifies correctly", () => {
  const raw = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }
  const info = classifyProviderError(raw)
  expect(info.kind).toBe("unavailable")
  expect(info.message).toBe("Overloaded")
})

test("plain-object auth body with no status classifies via type text", () => {
  const raw = {
    type: "error",
    error: { type: "authentication_error", message: "invalid x-api-key" },
  }
  const info = classifyProviderError(raw)
  expect(info.kind).toBe("auth")
  expect(info.message).toBe("invalid x-api-key")
})

test("doubly-nested {error:{error:{...}}} extracts message/type recursively", () => {
  const raw = { error: { error: { message: "deep bad request", type: "invalid_request_error" } } }
  const info = classifyProviderError(raw)
  expect(info.kind).toBe("bad_request")
  expect(info.message).toBe("deep bad request")
})

test("a flat {message} body with no error wrapper still extracts", () => {
  const info = classifyProviderError({ message: "service down", status: 503 })
  expect(info.kind).toBe("unavailable")
  expect(info.message).toBe("service down")
})

test("a FastAPI-style {detail} body still extracts", () => {
  const info = classifyProviderError({ detail: "model not found", status: 404 })
  expect(info.kind).toBe("bad_request")
  expect(info.message).toBe("model not found")
})


test("Anthropic's canonical 400 'prompt is too long' body classifies as context_length", () => {
  const body = {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 250000 tokens > 200000 maximum",
    },
  }
  const error = apiCallError({
    message: "prompt is too long: 250000 tokens > 200000 maximum",
    statusCode: 400,
    responseBody: JSON.stringify(body),
    data: body,
  })
  const info = classifyProviderError(error)
  expect(info.kind).toBe("context_length")
  expect(info.status).toBe(400)
  expect(describeProviderError(info)).toContain("/compact")
})

test("the same Anthropic overflow as a raw plain object (no wrapper, no status) classifies as context_length", () => {
  const info = classifyProviderError({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "prompt is too long: 250000 tokens > 200000 maximum",
    },
  })
  expect(info.kind).toBe("context_length")
})

test("Anthropic's 'input length and max_tokens exceed context limit' classifies as context_length", () => {
  const info = classifyProviderError(
    apiCallError({
      message: "input length and `max_tokens` exceed context limit: 200000 + 8192 > 200000",
      statusCode: 400,
      data: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "input length and `max_tokens` exceed context limit: 200000 + 8192 > 200000",
        },
      },
    }),
  )
  expect(info.kind).toBe("context_length")
})

test("Gemini's 'input token count exceeds the maximum' invalid_argument classifies as context_length", () => {
  const info = classifyProviderError({
    error: {
      code: 400,
      message:
        "The input token count (1189997) exceeds the maximum number of tokens allowed (1048575).",
      status: "INVALID_ARGUMENT",
      type: "invalid_argument",
    },
    status: 400,
  })
  expect(info.kind).toBe("context_length")
})

test("OpenAI's context_length_exceeded code classifies as context_length", () => {
  const info = classifyProviderError(
    apiCallError({
      message: "This model's maximum context length is 8192 tokens.",
      statusCode: 400,
      data: {
        error: {
          message:
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 10000 tokens. Please reduce the length of the messages.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      },
    }),
  )
  expect(info.kind).toBe("context_length")
})

test("a genuine invalid_request_error that is NOT an overflow stays bad_request", () => {
  const info = classifyProviderError(
    apiCallError({
      message: "messages: at least one message is required",
      statusCode: 400,
      data: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages: at least one message is required",
        },
      },
    }),
  )
  expect(info.kind).toBe("bad_request")
  expect(describeProviderError(info)).not.toContain("/compact")
})


test("an OpenAI quota body (type AND code both insufficient_quota) never duplicates the tag", () => {
  const human = "You exceeded your current quota, please check your plan and billing details."
  const info = classifyProviderError(
    apiCallError({
      message: human,
      statusCode: 429,
      data: { error: { message: human, type: "insufficient_quota", code: "insufficient_quota" } },
    }),
  )
  expect(info.kind).toBe("quota")
  expect(info.detail).toBe(`${human} (insufficient_quota)`)
  expect(info.detail?.match(/insufficient_quota/g)?.length).toBe(1)

  const line = describeProviderError(info)
  expect(line).toContain(human)
  expect(line.match(/insufficient_quota/g)?.length).toBe(1)
})

test("tag dedupe is case-insensitive", () => {
  const info = classifyProviderError({
    status: 402,
    error: {
      message: "Billing hard limit reached",
      type: "insufficient_quota",
      code: "INSUFFICIENT_QUOTA",
    },
  })
  expect(info.detail).toBe("Billing hard limit reached (insufficient_quota)")
})

test("a tag already stated by the human message is not appended again", () => {
  const info = classifyProviderError({
    status: 400,
    error: {
      message: "insufficient_quota",
      type: "insufficient_quota",
      code: "insufficient_quota",
    },
  })
  expect(info.detail).toBe("insufficient_quota")
})

test("detail falls back to the tags alone when the body has no human message", () => {
  const info = classifyProviderError({
    status: 500,
    error: { message: "", type: "overloaded_error" },
  })
  expect(info.detail).toBe("overloaded_error")
})

test("detail is capped like the JSON fallback", () => {
  const human = "x".repeat(500)
  const info = classifyProviderError({
    status: 402,
    error: { message: human, type: "insufficient_quota" },
  })
  expect(info.detail?.length).toBeLessThanOrEqual(301)
  expect(info.detail?.endsWith("…")).toBe(true)
})


test("string errors pass through verbatim as the message", () => {
  const info = classifyProviderError("connection reset by peer")
  expect(info.kind).toBe("unknown")
  expect(info.message).toBe("connection reset by peer")
})

test("plain Error instances classify as unknown using .message", () => {
  const info = classifyProviderError(new Error("boom"))
  expect(info.kind).toBe("unknown")
  expect(info.message).toBe("boom")
})

test("a DOMException named TimeoutError (chunk-timeout shape) classifies as timeout", () => {
  const error = new DOMException("firstChunk timeout of 300000ms exceeded", "TimeoutError")
  const info = classifyProviderError(error)
  expect(info.kind).toBe("timeout")
  expect(info.message).toContain("timeout")
})

test("REGRESSION: an unclassifiable plain object never renders as [object Object]", () => {
  const raw = { foo: 1, bar: [1, 2, 3], nested: { x: true } }
  const info = classifyProviderError(raw)
  expect(info.kind).toBe("unknown")
  expect(info.message).not.toContain("[object Object]")
  expect(info.message).toContain("foo")
  const rendered = describeProviderError(info)
  expect(rendered).not.toContain("[object Object]")
})

test("REGRESSION: describeProviderError never renders [object Object] for any classified kind", () => {
  const inputs: unknown[] = [
    apiCallError({ message: "x", statusCode: 429, responseHeaders: { "retry-after": "5" } }),
    apiCallError({ message: "x", statusCode: 401 }),
    apiCallError({ message: "x", statusCode: 402 }),
    apiCallError({ message: "x", statusCode: 529 }),
    { error: { message: "y", type: "z" } },
    { type: "error", error: { type: "overloaded_error", message: "y" } },
    "plain string error",
    new Error("plain error"),
    {},
    { totally: "unrecognized", shape: 1 },
  ]
  for (const input of inputs) {
    const rendered = describeProviderError(classifyProviderError(input))
    expect(rendered).not.toContain("[object Object]")
  }
})

test("unclassifiable-object JSON is capped to roughly 300 chars", () => {
  const raw: Record<string, string> = {}
  for (let i = 0; i < 100; i++) raw[`key${i}`] = "x".repeat(20)
  const info = classifyProviderError(raw)
  expect(info.message.length).toBeLessThanOrEqual(301)
  expect(info.message.endsWith("…")).toBe(true)
})


test("describeProviderError renders the rate_limit template with provider + retry", () => {
  const line = describeProviderError({
    kind: "rate_limit",
    message: "x",
    status: 429,
    provider: "openrouter",
    retryAfterSec: 30,
  })
  expect(line).toBe("rate limited by openrouter — retry in ~30s (429)")
})

test("describeProviderError renders the quota template with detail", () => {
  const line = describeProviderError({
    kind: "quota",
    message: "You exceeded your current quota",
    status: 402,
    detail: "insufficient_quota",
  })
  expect(line).toBe("quota/billing exhausted (402): insufficient_quota")
})

test("describeProviderError renders the auth template and mentions /provider", () => {
  const line = describeProviderError({ kind: "auth", message: "x", status: 401 })
  expect(line).toBe("invalid or missing API key (401) — /provider to update it")
})

test("describeProviderError renders the unavailable template", () => {
  const line = describeProviderError({ kind: "unavailable", message: "x", status: 529 })
  expect(line).toBe("provider unavailable/overloaded (529) — try again shortly")
})

test("describeProviderError renders the context_length template and mentions /compact", () => {
  const line = describeProviderError({ kind: "context_length", message: "x", status: 413 })
  expect(line).toBe("context window exceeded — /compact or a smaller task")
})

test("describeProviderError renders the unknown template with the best message", () => {
  const line = describeProviderError({ kind: "unknown", message: "connection reset by peer" })
  expect(line).toBe("unknown provider error: connection reset by peer")
})

test("only auth and context_length templates prescribe a command", () => {
  const kinds = [
    "rate_limit",
    "quota",
    "unavailable",
    "timeout",
    "network",
    "bad_request",
    "unknown",
  ] as const
  for (const kind of kinds) {
    const line = describeProviderError({ kind, message: "x", status: 500 })
    expect(line).not.toContain("/provider")
    expect(line).not.toContain("/compact")
  }
})
