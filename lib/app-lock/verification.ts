import { APP_LOCK_KEY_BYTES, type AppLockProvisioning } from "@/lib/app-lock/shared"

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function appLockBytesToBase64Url(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

function passwordMaterial(deviceId: string, password: string) {
  return new TextEncoder().encode(`${deviceId}\u0000${password}`)
}

export async function deriveAppLockVerifier(
  password: string,
  provisioning: Pick<AppLockProvisioning, "device_id" | "salt" | "iterations">
) {
  const key = await crypto.subtle.importKey(
    "raw",
    passwordMaterial(provisioning.device_id, password),
    "PBKDF2",
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(provisioning.salt),
      iterations: provisioning.iterations,
    },
    key,
    APP_LOCK_KEY_BYTES * 8
  )
  return appLockBytesToBase64Url(new Uint8Array(bits))
}

export function constantTimeAppLockEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left)
  const rightBytes = new TextEncoder().encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0)
  }
  return difference === 0
}

export async function verifyAppLockPassword(password: string, provisioning: AppLockProvisioning) {
  const candidate = await deriveAppLockVerifier(password, provisioning)
  return constantTimeAppLockEqual(candidate, provisioning.verifier)
}
