"use client"

import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"

export type DesktopBusinessLogo = {
  relativePath: string
  absolutePath: string
  mimeType: string
  width: number
  height: number
  bytes: number
}

type DesktopLocalAsset = {
  mimeType: string
  bytes: number[]
}

const businessLogoUrls = new Map<string, string>()
const businessLogoAssets = new Map<string, Promise<DesktopLocalAsset>>()

function readBusinessLogoAsset(relativePath: string) {
  const cached = businessLogoAssets.get(relativePath)
  if (cached) return cached
  const loading = invokeTauri<DesktopLocalAsset>("desktop_read_local_asset", { relativePath }).catch((error) => {
    businessLogoAssets.delete(relativePath)
    throw error
  })
  businessLogoAssets.set(relativePath, loading)
  return loading
}

function bytesToBase64(bytes: number[]) {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function invalidateBusinessLogoUrl(relativePath: string | null | undefined) {
  if (!relativePath) return
  const cachedUrl = businessLogoUrls.get(relativePath)
  if (cachedUrl) URL.revokeObjectURL(cachedUrl)
  businessLogoUrls.delete(relativePath)
  businessLogoAssets.delete(relativePath)
}

export async function pickBusinessLogo(organizationId: string) {
  if (!(await isTauriRuntimeAsync())) {
    throw new Error("Business logo selection is available in the Bezgrow desktop app.")
  }
  return invokeTauri<DesktopBusinessLogo | null>("desktop_pick_business_logo", { organizationId })
}

export async function removeBusinessLogo(relativePath: string) {
  if (!relativePath || !(await isTauriRuntimeAsync())) return
  await invokeTauri<void>("desktop_remove_business_logo", { relativePath })
  invalidateBusinessLogoUrl(relativePath)
}

export async function resolveBusinessLogoUrl(relativePath: string | null | undefined) {
  if (!relativePath || !(await isTauriRuntimeAsync())) return ""
  const cachedUrl = businessLogoUrls.get(relativePath)
  if (cachedUrl) return cachedUrl
  const asset = await readBusinessLogoAsset(relativePath)
  const url = URL.createObjectURL(new Blob([Uint8Array.from(asset.bytes)], { type: asset.mimeType }))
  businessLogoUrls.set(relativePath, url)
  return url
}

/**
 * Returns the exact locally persisted business-logo bytes as an in-memory URL.
 * Invoice generation uses this instead of a transient blob URL so the PDF owns
 * the image payload and remains complete after restart and fully offline.
 */
export async function resolveBusinessLogoDataUrl(relativePath: string | null | undefined) {
  if (!relativePath || !(await isTauriRuntimeAsync())) return ""
  const asset = await readBusinessLogoAsset(relativePath)
  if (!asset.bytes.length || !/^image\/(?:png|jpeg|webp)$/i.test(asset.mimeType)) return ""
  return `data:${asset.mimeType};base64,${bytesToBase64(asset.bytes)}`
}
