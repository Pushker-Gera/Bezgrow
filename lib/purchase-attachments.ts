"use client"

import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"

export type DesktopPurchaseAttachment = {
  relativePath: string
  absolutePath: string
  fileName: string
  mediaType: string
  bytes: number
  sha256: string
}

export async function pickPurchaseAttachment(organizationId: string, purchaseId: string) {
  if (!(await isTauriRuntimeAsync())) throw new Error("Supplier invoice attachments are available in the Bezgrow desktop app.")
  return invokeTauri<DesktopPurchaseAttachment | null>("desktop_pick_purchase_attachment", { organizationId, purchaseId })
}
