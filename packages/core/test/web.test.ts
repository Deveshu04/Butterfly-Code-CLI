import { expect, test } from "bun:test"
import { ButterflyConfig, substituteEnv } from "../src/config/config"
import type { ToolContext } from "../src/tool/registry"
import {
  braveSearchBackend,
  ddgSearchBackend,
  exaSearchBackend,
  tavilySearchBackend,
} from "../src/web/backends"
import { jinaFetchBackend, rawFetchBackend, tavilyExtractBackend } from "../src/web/extract"
import { decodeHtmlEntities, extractTitle, htmlToText } from "../src/web/html"
import { isPrivateOrReservedHost, SsrfError, validateFetchUrl } from "../src/web/ssrf"
import { buildWebBackends, createWebTool, looksCredentialBearing } from "../src/web/web-tool"

function ctx(): ToolContext {
  return { cwd: "/w", rules: { "*": "allow" }, state: {} }
}

function stub(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

function textStub(body: string, status = 200, headers?: Record<string, string>): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch
}

const noNetworkResolve = async () => ["93.184.216.34"]


test("htmlToText strips script/style/nav and collapses whitespace", () => {
  const html = `
    <html><head><style>.x{color:red}</style></head>
    <body>
      <nav>Home | About</nav>
      <script>console.log("hi")</script>
      <main>
        <h1>Title</h1>
        <p>Hello   world.</p>
        <p>Second   paragraph.</p>
      </main>
      <footer>copyright 2026</footer>
    </body></html>`
  const text = htmlToText(html)
  expect(text).not.toContain("console.log")
  expect(text).not.toContain("color:red")
  expect(text).not.toContain("Home | About")
  expect(text).not.toContain("copyright 2026")
  expect(text).toContain("Title")
  expect(text).toContain("Hello world.")
  expect(text).toContain("Second paragraph.")
  expect(text).not.toMatch(/ {2,}/)
})

test("htmlToText decodes common entities", () => {
  const html = "<p>Fish &amp; Chips &mdash; caf&#233; &lt;3 &#x2764;&#xFE0F;</p>"
  const text = htmlToText(html)
  expect(text).toContain("Fish & Chips")
  expect(text).toContain("café")
  expect(text).toContain("<3")
})

test("decodeHtmlEntities handles named, decimal, and hex forms", () => {
  expect(decodeHtmlEntities("a &amp; b")).toBe("a & b")
  expect(decodeHtmlEntities("&#65;&#66;&#67;")).toBe("ABC")
  expect(decodeHtmlEntities("&#x41;&#x42;")).toBe("AB")
  expect(decodeHtmlEntities("no entities here")).toBe("no entities here")
})

test("extractTitle pulls the <title> tag, decoded and trimmed", () => {
  expect(extractTitle("<html><head><title>  Bun &amp; SQLite  </title></head></html>")).toBe(
    "Bun & SQLite",
  )
  expect(extractTitle("<html><body>no title here</body></html>")).toBeUndefined()
})


test("validateFetchUrl refuses non-http(s) schemes", async () => {
  await expect(validateFetchUrl("file:///etc/passwd")).rejects.toThrow(SsrfError)
  await expect(validateFetchUrl("ftp://example.com/x")).rejects.toThrow(SsrfError)
  await expect(validateFetchUrl("not a url at all")).rejects.toThrow(SsrfError)
})

test("validateFetchUrl allows ordinary public https URLs", async () => {
  const url = await validateFetchUrl("https://example.com/docs", { resolveHost: noNetworkResolve })
  expect(url.hostname).toBe("example.com")
})

test("validateFetchUrl refuses literal loopback/private/link-local IPv4", async () => {
  for (const bad of [
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/", // cloud metadata
    "http://0.0.0.0/",
  ]) {
    await expect(validateFetchUrl(bad)).rejects.toThrow(SsrfError)
  }
})

test("validateFetchUrl refuses decimal/hex/octal-encoded loopback IPv4", async () => {
  // The WHATWG URL parser normalizes these to 127.0.0.1 before we ever see them.
  for (const bad of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
  ]) {
    await expect(validateFetchUrl(bad)).rejects.toThrow(SsrfError)
  }
})

test("validateFetchUrl refuses localhost and IPv6 loopback/link-local", async () => {
  await expect(validateFetchUrl("http://localhost/")).rejects.toThrow(SsrfError)
  await expect(validateFetchUrl("http://LOCALHOST/")).rejects.toThrow(SsrfError)
  await expect(validateFetchUrl("http://foo.localhost/")).rejects.toThrow(SsrfError)
  await expect(validateFetchUrl("http://[::1]/")).rejects.toThrow(SsrfError)
  await expect(validateFetchUrl("http://[fe80::1]/")).rejects.toThrow(SsrfError)
  await expect(validateFetchUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(SsrfError)
})

test("isPrivateOrReservedHost is a pure classifier for literal addresses", () => {
  expect(isPrivateOrReservedHost("127.0.0.1")).toBe(true)
  expect(isPrivateOrReservedHost("8.8.8.8")).toBe(false)
  expect(isPrivateOrReservedHost("example.com")).toBe(false) // not a literal IP
})

test("validateFetchUrl resolves hostnames via an injectable resolver and blocks private results", async () => {
  const resolveHost = async (hostname: string) =>
    hostname === "evil.example.com" ? ["10.0.0.9"] : ["93.184.216.34"]
  await expect(validateFetchUrl("https://evil.example.com/", { resolveHost })).rejects.toThrow(
    SsrfError,
  )
  const ok = await validateFetchUrl("https://good.example.com/", { resolveHost })
  expect(ok.hostname).toBe("good.example.com")
})


test("tavilySearchBackend maps results[].content into snippet", async () => {
  const backend = tavilySearchBackend({
    apiKey: "tvly-x",
    fetchFn: stub({
      results: [
        {
          title: "SQLite - Bun",
          url: "https://bun.com/docs/runtime/sqlite",
          content: "Bun natively implements SQLite.",
          score: 0.98,
        },
      ],
    }),
  })
  const result = await backend.search("bun sqlite", { maxResults: 5 })
  expect(result.hits).toEqual([
    {
      title: "SQLite - Bun",
      url: "https://bun.com/docs/runtime/sqlite",
      snippet: "Bun natively implements SQLite.",
      score: 0.98,
    },
  ])
})

test("tavilySearchBackend throws with the HTTP status on a hard failure", async () => {
  const backend = tavilySearchBackend({ apiKey: "bad", fetchFn: stub({}, 401) })
  await expect(backend.search("q", { maxResults: 5 })).rejects.toThrow(/401/)
})

test("braveSearchBackend maps web.results[] and prefers extra_snippets", async () => {
  const backend = braveSearchBackend({
    apiKey: "brave-x",
    fetchFn: stub({
      web: {
        results: [
          {
            title: "Bun docs",
            url: "https://bun.com",
            description: "short",
            extra_snippets: ["longer snippet text"],
            page_age: "2026-01-01",
          },
        ],
      },
    }),
  })
  const result = await backend.search("bun", { maxResults: 5 })
  expect(result.hits[0]).toMatchObject({
    title: "Bun docs",
    url: "https://bun.com",
    snippet: "longer snippet text",
    published: "2026-01-01",
  })
})

test("exaSearchBackend maps results[].text and surfaces costDollars.total", async () => {
  const backend = exaSearchBackend({
    apiKey: "exa-x",
    fetchFn: stub({
      results: [{ title: "Exa result", url: "https://exa.ai/x", text: "some text" }],
      costDollars: { total: 0.007 },
    }),
  })
  const result = await backend.search("q", { maxResults: 5 })
  expect(result.hits[0]).toMatchObject({
    title: "Exa result",
    url: "https://exa.ai/x",
    snippet: "some text",
  })
  expect(result.costUSD).toBe(0.007)
})

test("ddgSearchBackend parses lite.duckduckgo.com result-link/result-snippet markup", async () => {
  const html = `<html><body><table>
    <tr><td><a rel="nofollow" href="https://bun.com/docs/runtime/sqlite" class='result-link'>SQLite - Bun</a></td></tr>
    <tr><td class='result-snippet'>Bun natively implements a high-performance SQLite3 driver.</td></tr>
    <tr><td><a rel="nofollow" href="https://example.com/other" class='result-link'>Other result</a></td></tr>
    <tr><td class='result-snippet'>Some other snippet &amp; text.</td></tr>
  </table></body></html>`
  const backend = ddgSearchBackend({ fetchFn: textStub(html) })
  const result = await backend.search("bun sqlite", { maxResults: 5 })
  expect(result.hits).toEqual([
    {
      title: "SQLite - Bun",
      url: "https://bun.com/docs/runtime/sqlite",
      snippet: "Bun natively implements a high-performance SQLite3 driver.",
    },
    {
      title: "Other result",
      url: "https://example.com/other",
      snippet: "Some other snippet & text.",
    },
  ])
})

test("ddgSearchBackend treats HTTP 202 as rate-limited and does not retry", async () => {
  const backend = ddgSearchBackend({ fetchFn: textStub("anomaly page", 202) })
  await expect(backend.search("q", { maxResults: 5 })).rejects.toThrow(/202|rate-limit/i)
})


test("tavilyExtractBackend returns raw_content as markdown", async () => {
  const backend = tavilyExtractBackend({
    apiKey: "tvly-x",
    fetchFn: stub({ results: [{ url: "https://bun.com", raw_content: "# Bun\n\nBody text" }] }),
  })
  const result = await backend.extract("https://bun.com", {})
  expect(result.markdown).toBe("# Bun\n\nBody text")
})

test("tavilyExtractBackend throws when the URL is in failed_results", async () => {
  const backend = tavilyExtractBackend({
    apiKey: "tvly-x",
    fetchFn: stub({ results: [], failed_results: [{ url: "https://bun.com", error: "timeout" }] }),
  })
  await expect(backend.extract("https://bun.com", {})).rejects.toThrow(/timeout/)
})

test("jinaFetchBackend parses the Title/URL Source/Markdown Content envelope", async () => {
  const body =
    "Title: SQLite - Bun\n\nURL Source: https://bun.com/docs/runtime/sqlite\n\nMarkdown Content:\nBun natively implements SQLite.\n"
  const backend = jinaFetchBackend({ fetchFn: textStub(body) })
  const result = await backend.extract("https://bun.com/docs/runtime/sqlite", {})
  expect(result.title).toBe("SQLite - Bun")
  expect(result.markdown).toBe("Bun natively implements SQLite.")
})

test("rawFetchBackend converts html to text and extracts the title", async () => {
  const html =
    "<html><head><title>Example</title></head><body><script>bad()</script><p>Hello <b>world</b>.</p></body></html>"
  const backend = rawFetchBackend({
    fetchFn: textStub(html, 200, { "content-type": "text/html" }),
    resolveHost: noNetworkResolve,
  })
  const result = await backend.extract("https://example.com/", {})
  expect(result.title).toBe("Example")
  expect(result.markdown).toContain("Hello world.")
  expect(result.markdown).not.toContain("bad()")
})

test("rawFetchBackend refuses a private-network URL before ever calling fetch", async () => {
  let called = false
  const fetchFn = (async () => {
    called = true
    return new Response("", { status: 200 })
  }) as unknown as typeof fetch
  const backend = rawFetchBackend({ fetchFn })
  await expect(backend.extract("http://127.0.0.1/admin", {})).rejects.toThrow(SsrfError)
  expect(called).toBe(false)
})

test("rawFetchBackend follows redirects, validating every hop, and refuses a private redirect target", async () => {
  const calls: string[] = []
  const fetchFn = (async (url: unknown) => {
    const u = String(url)
    calls.push(u)
    if (u === "https://good.example.com/start") {
      return new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/secret" },
      })
    }
    return new Response("unexpected", { status: 200 })
  }) as unknown as typeof fetch
  const backend = rawFetchBackend({ fetchFn, resolveHost: noNetworkResolve })
  await expect(backend.extract("https://good.example.com/start", {})).rejects.toThrow(SsrfError)
  expect(calls).toEqual(["https://good.example.com/start"])
})

test("rawFetchBackend follows a chain of valid redirects to the final page", async () => {
  const fetchFn = (async (url: unknown) => {
    const u = String(url)
    if (u === "https://a.example.com/") {
      return new Response("", { status: 301, headers: { location: "https://b.example.com/" } })
    }
    if (u === "https://b.example.com/") {
      return new Response("<html><body><p>final page</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    }
    throw new Error(`unexpected fetch ${u}`)
  }) as unknown as typeof fetch
  const backend = rawFetchBackend({ fetchFn, resolveHost: noNetworkResolve })
  const result = await backend.extract("https://a.example.com/", {})
  expect(result.markdown).toContain("final page")
})

test("rawFetchBackend enforces a byte size cap and marks the result truncated", async () => {
  const big = "x".repeat(1000)
  const fetchFn = textStub(big, 200, { "content-type": "text/plain" })
  const backend = rawFetchBackend({ fetchFn, maxBytes: 100, resolveHost: noNetworkResolve })
  const result = await backend.extract("https://example.com/big", {})
  expect(result.markdown.length).toBeLessThan(1000)
  expect(result.markdown).toContain("truncated")
})

test("rawFetchBackend surfaces non-2xx responses as errors", async () => {
  const backend = rawFetchBackend({ fetchFn: textStub("nope", 404), resolveHost: noNetworkResolve })
  await expect(backend.extract("https://example.com/missing", {})).rejects.toThrow(/404/)
})


test("ButterflyConfig accepts the web block schema", () => {
  const parsed = ButterflyConfig.parse({
    web: {
      provider: "tavily",
      tavily: { apiKey: "{env:TAVILY_API_KEY}" },
      brave: { apiKey: "brave-key" },
      maxResults: 5,
      maxFetchChars: 20_000,
      allowDuckDuckGo: true,
    },
  })
  expect(parsed.web?.tavily?.apiKey).toBe("{env:TAVILY_API_KEY}")
})

test("substituteEnv resolves {env:VAR} inside web.tavily.apiKey like every other config key", () => {
  const resolved = substituteEnv(
    { web: { tavily: { apiKey: "{env:TAVILY_API_KEY}" } } },
    { TAVILY_API_KEY: "tvly-abc123" },
  ) as { web: { tavily: { apiKey: string } } }
  expect(resolved.web.tavily.apiKey).toBe("tvly-abc123")
})


test("buildWebBackends picks the first backend whose key is configured", () => {
  const { searchChain } = buildWebBackends({ tavily: { apiKey: "t" }, brave: { apiKey: "b" } })
  expect(searchChain.map((b) => b.name)).toEqual(["tavily", "brave", "ddg"])
})

test("buildWebBackends honors an explicit provider pin and does not fall back", () => {
  const { searchChain } = buildWebBackends({
    provider: "brave",
    tavily: { apiKey: "t" },
    brave: { apiKey: "b" },
  })
  expect(searchChain.map((b) => b.name)).toEqual(["brave"])
})

test("buildWebBackends yields an empty search chain when pinned to an unconfigured/unimplemented provider", () => {
  const { searchChain: noKey } = buildWebBackends({ provider: "brave" })
  expect(noKey).toEqual([])
  const { searchChain: unimplemented } = buildWebBackends({ provider: "openrouter" })
  expect(unimplemented).toEqual([])
})

test("buildWebBackends falls back to ddg when no keys are configured and ddg is allowed", () => {
  const { searchChain } = buildWebBackends(undefined)
  expect(searchChain.map((b) => b.name)).toEqual(["ddg"])
})

test("buildWebBackends drops ddg entirely when allowDuckDuckGo is false", () => {
  const { searchChain } = buildWebBackends({ allowDuckDuckGo: false })
  expect(searchChain).toEqual([])
})

test("buildWebBackends fetch chain always ends in raw (no key required)", () => {
  const { fetchChain } = buildWebBackends(undefined)
  expect(fetchChain.map((b) => b.name)).toEqual(["raw"])
  const { fetchChain: withTavily } = buildWebBackends({ tavily: { apiKey: "t" } })
  expect(withTavily.map((b) => b.name)).toEqual(["tavily", "raw"])
})


test("createWebTool op=search formats numbered results with a backend trailer", async () => {
  const tool = createWebTool({
    config: () => ({ tavily: { apiKey: "t" } }),
    fetchFn: stub({
      results: [
        {
          title: "SQLite - Bun",
          url: "https://bun.com/docs",
          content: "Bun implements SQLite.",
          score: 0.9,
        },
      ],
    }),
  })
  const result = await tool.execute({ op: "search", query: "bun sqlite" }, ctx())
  expect(result.isError).toBeFalsy()
  expect(result.output).toContain("[1] SQLite - Bun — https://bun.com/docs")
  expect(result.output).toContain("Bun implements SQLite.")
  expect(result.output).toContain("(1 result · tavily)")
  expect((result.meta as { backend: string }).backend).toBe("tavily")
})

test("createWebTool op=search with no query is a clear, terse error", async () => {
  const tool = createWebTool({ config: () => ({ tavily: { apiKey: "t" } }) })
  const result = await tool.execute({ op: "search" }, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("query")
})

test("createWebTool op=search with no backend configured self-describes the fix", async () => {
  const tool = createWebTool({ config: () => ({ allowDuckDuckGo: false }) })
  const result = await tool.execute({ op: "search", query: "x" }, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("web.tavily.apiKey")
})

test("createWebTool op=fetch renders a title/url header plus body and truncates over the char budget", async () => {
  const html = "<html><head><title>Example</title></head><body><p>hello</p></body></html>"
  const fetchFn = (async (url: unknown) => {
    if (String(url).startsWith("https://r.jina.ai/")) return new Response("", { status: 404 })
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } })
  }) as unknown as typeof fetch
  const tool = createWebTool({
    config: () => ({}),
    fetchFn,
    resolveHost: noNetworkResolve,
    maxFetchChars: 3,
  })
  const result = await tool.execute({ op: "fetch", url: "https://example.com/" }, ctx())
  expect(result.output).toContain("# Example")
  expect(result.output).toContain("https://example.com/")
  expect(result.output).toContain("truncated")
})

test("createWebTool op=fetch refuses a private-network URL with an isError, never throwing", async () => {
  const tool = createWebTool({ config: () => ({}) })
  const result = await tool.execute({ op: "fetch", url: "http://127.0.0.1/" }, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("Refused")
})

test("createWebTool op=fetch with no url is a clear, terse error", async () => {
  const tool = createWebTool({ config: () => ({}) })
  const result = await tool.execute({ op: "fetch" }, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("url")
})

test("createWebTool permissionTarget exposes the fetch host for the permission tree, and nothing for search", () => {
  const tool = createWebTool({ config: () => ({}) })
  expect(tool.permissionTarget?.({ op: "fetch", url: "https://example.com/x" })).toBe("example.com")
  expect(tool.permissionTarget?.({ op: "search", query: "x" })).toBeUndefined()
  expect(tool.permissionTarget?.({ op: "fetch", url: "not a url" })).toBeUndefined()
})

test("createWebTool description contains no self-preferential phrasing", () => {
  const tool = createWebTool({ config: () => ({}) })
  const lower = tool.description.toLowerCase()
  expect(lower).not.toContain("prefer this tool")
  expect(lower).not.toContain("always use")
  expect(lower).not.toContain("you should always")
})


test("buildWebBackends keeps r.jina.ai out of the fetch chain unless opted in", () => {
  expect(buildWebBackends(undefined).fetchChain.map((b) => b.name)).toEqual(["raw"])
  expect(buildWebBackends({ allowJina: true }).fetchChain.map((b) => b.name)).toEqual([
    "jina",
    "raw",
  ])
  // Configuring a jina key IS the opt-in signal (you cannot set a key by accident).
  expect(buildWebBackends({ jinaKey: "jina_x" }).fetchChain.map((b) => b.name)).toEqual([
    "jina",
    "raw",
  ])
  expect(
    buildWebBackends({ jinaKey: "jina_x", allowJina: false }).fetchChain.map((b) => b.name),
  ).toEqual(["raw"])
})

test("config can express 'no third parties at all' with zero API keys", () => {
  const { searchChain, fetchChain } = buildWebBackends({ allowDuckDuckGo: false })
  expect(searchChain).toEqual([])
  expect(fetchChain.map((b) => b.name)).toEqual(["raw"])
})

test("createWebTool permissionNote discloses third-party transit at approval time", () => {
  const direct = createWebTool({ config: () => ({}) })
  expect(direct.permissionNote?.({ op: "fetch", url: "https://example.com/x" })).toBeUndefined()

  const viaJina = createWebTool({ config: () => ({ allowJina: true }) })
  expect(viaJina.permissionNote?.({ op: "fetch", url: "https://example.com/x" })).toContain(
    "r.jina.ai",
  )

  const viaBoth = createWebTool({ config: () => ({ tavily: { apiKey: "t" }, allowJina: true }) })
  const note = viaBoth.permissionNote?.({ op: "fetch", url: "https://example.com/x" }) ?? ""
  expect(note).toContain("api.tavily.com")
  expect(note).toContain("r.jina.ai")

  const search = createWebTool({ config: () => ({ tavily: { apiKey: "t" } }) })
  expect(search.permissionNote?.({ op: "search", query: "x" })).toContain("api.tavily.com")
})

test("createWebTool refuses to route a credential-bearing URL through any third party", async () => {
  const calls: string[] = []
  const fetchFn = (async (url: unknown) => {
    calls.push(String(url))
    return new Response("<html><body><p>signed object</p></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })
  }) as unknown as typeof fetch
  const url = "https://bucket.s3.amazonaws.com/o.txt?X-Amz-Signature=deadbeef&X-Amz-Expires=60"
  const tool = createWebTool({
    config: () => ({ tavily: { apiKey: "t" }, allowJina: true }),
    fetchFn,
    resolveHost: noNetworkResolve,
  })
  const result = await tool.execute({ op: "fetch", url }, ctx())
  expect(result.isError).toBeFalsy()
  expect(calls.some((c) => c.includes("r.jina.ai") || c.includes("api.tavily.com"))).toBe(false)
  expect(calls).toEqual([url])
  expect(tool.permissionNote?.({ op: "fetch", url })).toContain("direct only")
})

test("looksCredentialBearing flags signed/tokenized URLs and leaves plain ones alone", () => {
  expect(looksCredentialBearing("https://example.com/docs")).toBe(false)
  expect(looksCredentialBearing("https://example.com/docs?page=2&q=bun")).toBe(false)
  expect(looksCredentialBearing("https://s3.amazonaws.com/o?X-Amz-Credential=AKIA")).toBe(true)
  expect(looksCredentialBearing("https://example.com/f?token=abc")).toBe(true)
  expect(looksCredentialBearing("https://example.com/f?sig=abc")).toBe(true)
  expect(looksCredentialBearing("https://example.com/f?access_token=abc")).toBe(true)
  expect(looksCredentialBearing("https://user:pw@example.com/f")).toBe(true)
  expect(looksCredentialBearing("not a url")).toBe(false)
})


test("web.maxResults from config drives the request; constructor opts and per-call args override", async () => {
  const bodies: string[] = []
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  }) as unknown as typeof fetch

  const fromConfig = createWebTool({
    config: () => ({ tavily: { apiKey: "t" }, maxResults: 2 }),
    fetchFn,
  })
  await fromConfig.execute({ op: "search", query: "q" }, ctx())
  expect(JSON.parse(bodies[0] ?? "{}").max_results).toBe(2)

  const optsWin = createWebTool({
    config: () => ({ tavily: { apiKey: "t" }, maxResults: 2 }),
    fetchFn,
    maxResults: 7,
  })
  await optsWin.execute({ op: "search", query: "q" }, ctx())
  expect(JSON.parse(bodies[1] ?? "{}").max_results).toBe(7)

  await fromConfig.execute({ op: "search", query: "q", maxResults: 4 }, ctx())
  expect(JSON.parse(bodies[2] ?? "{}").max_results).toBe(4)
})

test("web.maxFetchChars from config truncates the model-visible body", async () => {
  const html = `<html><head><title>T</title></head><body><p>${"abcdefghij".repeat(50)}</p></body></html>`
  const tool = createWebTool({
    config: () => ({ maxFetchChars: 12 }),
    fetchFn: textStub(html, 200, { "content-type": "text/html" }),
    resolveHost: noNetworkResolve,
  })
  const result = await tool.execute({ op: "fetch", url: "https://example.com/" }, ctx())
  expect(result.output).toContain("truncated at 12 chars")
})


test("op=fetch keeps the full capture in meta while the model sees only the truncated body", async () => {
  const html = `<html><head><title>Big</title></head><body><p>${"z".repeat(50_000)}</p></body></html>`
  const tool = createWebTool({
    config: () => ({ maxFetchChars: 100 }),
    fetchFn: textStub(html, 200, { "content-type": "text/html" }),
    resolveHost: noNetworkResolve,
  })
  const result = await tool.execute({ op: "fetch", url: "https://example.com/" }, ctx())
  expect(result.output.length).toBeLessThan(500)
  const meta = result.meta as { text: string; chars: number; truncatedForModel: boolean }
  expect(meta.text.length).toBeGreaterThanOrEqual(50_000)
  expect(meta.chars).toBeGreaterThanOrEqual(50_000)
  expect(meta.truncatedForModel).toBe(true)
})

test("the meta capture is itself capped so one huge page cannot bloat the journal", async () => {
  const html = `<html><body><p>${"y".repeat(250_000)}</p></body></html>`
  const tool = createWebTool({
    config: () => ({}),
    fetchFn: textStub(html, 200, { "content-type": "text/html" }),
    resolveHost: noNetworkResolve,
  })
  const result = await tool.execute({ op: "fetch", url: "https://example.com/" }, ctx())
  const meta = result.meta as { text: string; chars: number }
  expect(meta.text.length).toBe(200_000)
  expect(meta.chars).toBeGreaterThan(200_000)
})


/** Never settles unless the caller's signal aborts it — proves the wiring. */
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      if (signal.aborted) {
        reject(new Error("aborted"))
        return
      }
      signal.addEventListener("abort", () => reject(new Error("aborted")))
    })) as unknown as typeof fetch
}

test("op=fetch cancels in-flight backend requests when ctx.signal aborts", async () => {
  const controller = new AbortController()
  const tool = createWebTool({
    config: () => ({ allowJina: true }),
    fetchFn: hangingFetch(),
    resolveHost: noNetworkResolve,
  })
  const pending = tool.execute(
    { op: "fetch", url: "https://example.com/" },
    { ...ctx(), signal: controller.signal },
  )
  controller.abort()
  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.output.toLowerCase()).toContain("abort")
})

test("op=search cancels in-flight backend requests when ctx.signal aborts", async () => {
  const controller = new AbortController()
  const tool = createWebTool({
    config: () => ({ tavily: { apiKey: "t" } }),
    fetchFn: hangingFetch(),
  })
  const pending = tool.execute(
    { op: "search", query: "q" },
    { ...ctx(), signal: controller.signal },
  )
  controller.abort()
  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.output.toLowerCase()).toContain("abort")
})


test("validateFetchUrl fails CLOSED when the resolver errors or answers with nothing", async () => {
  const throwing = async () => {
    throw new Error("ENOTFOUND")
  }
  await expect(
    validateFetchUrl("https://intranet.corp/", { resolveHost: throwing }),
  ).rejects.toThrow(SsrfError)

  const empty = async () => []
  await expect(validateFetchUrl("https://intranet.corp/", { resolveHost: empty })).rejects.toThrow(
    SsrfError,
  )
})

test("op=fetch never leaks an unresolvable hostname to a third-party backend", async () => {
  const calls: string[] = []
  const fetchFn = (async (url: unknown) => {
    calls.push(String(url))
    return new Response("", { status: 200 })
  }) as unknown as typeof fetch
  const tool = createWebTool({
    config: () => ({ tavily: { apiKey: "t" }, allowJina: true }),
    fetchFn,
    resolveHost: async () => {
      throw new Error("ENOTFOUND")
    },
  })
  const result = await tool.execute({ op: "fetch", url: "https://intranet.corp/secret" }, ctx())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("Refused")
  expect(calls).toEqual([])
})
