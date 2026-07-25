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

export function invalidateBusinessLogoUrl(relativePath: string | null | undefined) {
  if (!relativePath) return
  const cachedUrl = businessLogoUrls.get(relativePath)
  if (cachedUrl) URL.revokeObjectURL(cachedUrl)
  businessLogoUrls.delete(relativePath)
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
  const asset = await invokeTauri<DesktopLocalAsset>("desktop_read_local_asset", { relativePath })
  const url = URL.createObjectURL(new Blob([Uint8Array.from(asset.bytes)], { type: asset.mimeType }))
  businessLogoUrls.set(relativePath, url)
  return url
}
