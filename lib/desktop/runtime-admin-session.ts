import "server-only"

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const DESKTOP_ADMIN_PAGE_COOKIE = "bezgrow_platform_admin_page"
export const DESKTOP_ADMIN_PAGE_TTL_SECONDS = 10 * 60

function runtimeToken() {
  if (process.env.BEZGROW_DESKTOP_BUILD !== "1") return null
  const token = process.env.BEZGROW_RUNTIME_TOKEN?.trim()
  return token && token.length >= 32 ? token : null
}

function signature(payload: string, token: string) {
  return createHmac("sha256", token)
    .update(`bezgrow-platform-admin-page-v1\n${payload}`)
    .digest("hex")
}

export function issueDesktopAdminPageSession(nowSeconds = Math.floor(Date.now() / 1000)) {
  const token = runtimeToken()
  if (!token) return null
  const expiresAt = nowSeconds + DESKTOP_ADMIN_PAGE_TTL_SECONDS
  const payload = `${nowSeconds}.${expiresAt}.${randomBytes(16).toString("hex")}`
  return `${payload}.${signature(payload, token)}`
}

export function verifyDesktopAdminPageSession(
  value: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const token = runtimeToken()
  if (!token || !value) return false
  const parts = value.split(".")
  if (parts.length !== 4) return false
  const [issuedText, expiresText, nonce, suppliedSignature] = parts
  if (!/^\d{10}$/.test(issuedText) || !/^\d{10}$/.test(expiresText)) return false
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(suppliedSignature)) return false
  const issuedAt = Number(issuedText)
  const expiresAt = Number(expiresText)
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > nowSeconds + 5 ||
    expiresAt <= nowSeconds ||
    expiresAt - issuedAt !== DESKTOP_ADMIN_PAGE_TTL_SECONDS
  ) return false
  const payload = `${issuedText}.${expiresText}.${nonce}`
  const expected = Buffer.from(signature(payload, token), "hex")
  const supplied = Buffer.from(suppliedSignature, "hex")
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}

export const desktopAdminPageCookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: false,
  path: "/",
  maxAge: DESKTOP_ADMIN_PAGE_TTL_SECONDS,
}
