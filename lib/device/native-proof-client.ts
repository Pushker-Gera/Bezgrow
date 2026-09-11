"use client"

import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"

type DeviceProof = {
  deviceId: string
  publicKey: string
  signature: string
  timestamp: string
  nonce: string
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function nativeOnboardingProofHeaders(body: string) {
  if (!(await isTauriRuntimeAsync().catch(() => false))) {
    throw new Error("Business setup is available only in the Bezgrow desktop app.")
  }
  const proof = await invokeTauri<DeviceProof>("desktop_platform_admin_proof", {
    method: "POST",
    pathAndQuery: "/api/entitlements/onboard",
    bodySha256: await sha256Hex(body),
  })
  return {
    "x-bezgrow-device-id": proof.deviceId,
    "x-bezgrow-device-public-key": proof.publicKey,
    "x-bezgrow-device-signature": proof.signature,
    "x-bezgrow-device-timestamp": proof.timestamp,
    "x-bezgrow-device-nonce": proof.nonce,
  }
}
