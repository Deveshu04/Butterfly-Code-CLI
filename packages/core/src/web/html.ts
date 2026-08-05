
const COMMENTS = /<!--[\s\S]*?-->/g
const REMOVE_BLOCKS =
  /<(script|style|noscript|template|svg|iframe|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi
const BLOCK_BREAKS = /<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)>/gi
const LINE_BREAKS = /<br\s*\/?>/gi
const TAGS = /<[^>]+>/g

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
}

/** Decodes named/decimal/hex HTML entities. Unknown entities pass through unchanged. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X"
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const replacement = NAMED_ENTITIES[body.toLowerCase()]
    return replacement ?? whole
  })
}

/** Pulls and decodes the document title tag, or undefined if absent/empty. */
export function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return undefined
  const title = decodeHtmlEntities(match[1] ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return title === "" ? undefined : title
}

/** Strips markup down to readable text; used for both full pages and short fragments. */
export function htmlToText(html: string): string {
  let text = html.replace(COMMENTS, "").replace(REMOVE_BLOCKS, "\n")
  text = text.replace(BLOCK_BREAKS, "\n").replace(LINE_BREAKS, "\n")
  text = text.replace(TAGS, "")
  text = decodeHtmlEntities(text)
  text = text.replace(/[ \t]+/g, " ")
  text = text.replace(/ *\n */g, "\n")
  text = text.replace(/\n{3,}/g, "\n\n")
  return text.trim()
}
