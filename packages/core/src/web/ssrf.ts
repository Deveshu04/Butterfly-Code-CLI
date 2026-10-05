import { isIP } from "node:net"

/**
 * SSRF guard for op=fetch: refuses non-http(s) schemes and private, loopback
 * and link-local addresses, including those a domain resolves to. Lookup
 * failure is a refusal. Pre-flight only: DNS rebinding is not prevented.
 * Tests must inject `resolveHost`.
 */
export class SsrfError extends Error {}

export interface ValidateFetchUrlOptions {
  resolveHost?: (hostname: string) => Promise<string[]>
}

/** Unguarded on purpose: a lookup failure must surface as a refusal. */
async function defaultResolveHost(hostname: string): Promise<string[]> {
  const dns = await import("node:dns/promises")
  const records = await dns.lookup(hostname, { all: true })
  return records.map((record) => record.address)
}

function ipv4ToOctets(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => Number.parseInt(part, 10))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
  return octets as [number, number, number, number]
}

/** RFC1918 + loopback + link-local (incl. cloud metadata) + CGNAT + multicast/reserved. */
export function isPrivateOrReservedIPv4(ip: string): boolean {
  const octets = ipv4ToOctets(ip)
  if (!octets) return true // fail closed on anything we can't parse
  const [a, b] = octets
  if (a === 127) return true // loopback
  if (a === 10) return true // private
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 169 && b === 254) return true // link-local, incl. 169.254.169.254 metadata
  if (a === 0) return true // "this network"
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT (RFC 6598)
  if (a >= 224) return true // multicast (224-239) + reserved (240-255) + broadcast
  return false
}

function extractIPv4Mapped(ipv6: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ipv6)
  if (dotted) return dotted[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6)
  if (!hex) return undefined
  const hi = Number.parseInt(hex[1] ?? "0", 16)
  const lo = Number.parseInt(hex[2] ?? "0", 16)
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
}

/** Loopback (::1), unspecified (::), link-local (fe80::/10), unique-local (fc00::/7), IPv4-mapped. */
export function isPrivateOrReservedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === "::1" || lower === "::") return true
  if (/^fe[89ab]/.test(lower)) return true // fe80::/10 link-local (fe80-febf)
  if (/^f[cd]/.test(lower)) return true // fc00::/7 unique local (fc00-fdff)
  const mapped = extractIPv4Mapped(lower)
  if (mapped) return isPrivateOrReservedIPv4(mapped)
  return false
}

/** Classifies a literal IP (or "localhost") as private/reserved. Domain names return false. */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const stripped = hostname.replace(/^\[|\]$/g, "")
  const lower = stripped.toLowerCase()
  if (lower === "localhost" || lower.endsWith(".localhost")) return true
  const version = isIP(stripped)
  if (version === 4) return isPrivateOrReservedIPv4(stripped)
  if (version === 6) return isPrivateOrReservedIPv6(stripped)
  return false
}

/**
 * Parses and validates a fetch target: http(s) only, not a literal
 * private/loopback/link-local address, and (for domain names) not resolving
 * to one either. Throws SsrfError with a caller-safe message on refusal.
 * Callers that follow redirects manually MUST call this again on every hop.
 */
export async function validateFetchUrl(
  urlStr: string,
  opts: ValidateFetchUrlOptions = {},
): Promise<URL> {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    throw new SsrfError(`invalid URL "${urlStr}"`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`refused non-http(s) scheme "${url.protocol}"`)
  }
  const strippedHost = url.hostname.replace(/^\[|\]$/g, "")
  if (isPrivateOrReservedHost(url.hostname)) {
    throw new SsrfError(`refused private/reserved address "${strippedHost}"`)
  }
  if (isIP(strippedHost) === 0) {
    const resolve = opts.resolveHost ?? defaultResolveHost
    let addresses: string[]
    try {
      addresses = await resolve(url.hostname)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new SsrfError(`refused "${url.hostname}" - DNS resolution failed (${reason})`)
    }
    if (addresses.length === 0) {
      throw new SsrfError(`refused "${url.hostname}" - DNS resolution returned no addresses`)
    }
    for (const address of addresses) {
      if (isPrivateOrReservedHost(address)) {
        throw new SsrfError(
          `refused "${url.hostname}" - resolves to private/reserved address "${address}"`,
        )
      }
    }
  }
  return url
}
