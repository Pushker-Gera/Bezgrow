import "server-only"

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "")
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true
  }

  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized
  if (isIP(ipv4) !== 4) return false
  const [first, second] = ipv4.split(".").map(Number)
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  )
}

export async function isPublicHttpsUrl(url: URL) {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    isPrivateAddress(url.hostname)
  ) {
    return false
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  return addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address))
}
