import type { PrintSettings } from "@/components/print/types"
import { getOfflineMeta, setOfflineMeta } from "@/lib/offline/db"

export const defaultPrintSettings: PrintSettings = {
  defaultFormat: "a4",
  thermalWidth: "80mm",
  paperSize: "A4",
  margins: "standard",
  fontSize: "standard",
  showLogo: true,
  showQr: true,
  showBarcode: true,
  showHsn: true,
  showGstDetails: true,
  showSignature: true,
  showWatermark: false,
  pharmaMode: false,
  autoPrintAfterSave: false,
}

export function readStoredPrintSettings() {
  if (typeof window === "undefined") return defaultPrintSettings

  try {
    const stored = window.localStorage.getItem("bezgrow.print-settings")
    return stored ? normalizePrintSettings(JSON.parse(stored)) : defaultPrintSettings
  } catch {
    return defaultPrintSettings
  }
}

export function saveStoredPrintSettings(settings: PrintSettings) {
  if (typeof window === "undefined") return
  window.localStorage.setItem("bezgrow.print-settings", JSON.stringify(settings))
}

export function normalizePrintSettings(value: unknown): PrintSettings {
  const parsed = value && typeof value === "object" ? value as Record<string, unknown> : {}
  // Older releases persisted `blackAndWhite`. It is intentionally ignored so
  // OS/printer monochrome controls remain the single source of that choice.
  const { blackAndWhite: _retiredBlackAndWhite, ...compatible } = parsed
  void _retiredBlackAndWhite
  return { ...defaultPrintSettings, ...compatible } as PrintSettings
}

export async function loadStoredPrintSettings(organizationId: string) {
  const cached = readStoredPrintSettings()
  if (!organizationId) return cached

  const stored = await getOfflineMeta("print_settings_json", "", organizationId)
  if (!stored) return cached

  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored
    const settings = normalizePrintSettings(parsed)
    saveStoredPrintSettings(settings)
    return settings
  } catch {
    return cached
  }
}

export async function persistPrintSettings(organizationId: string, settings: PrintSettings) {
  saveStoredPrintSettings(settings)
  if (!organizationId) throw new Error("No active business is available for print settings.")
  await setOfflineMeta("print_settings_json", JSON.stringify(settings), organizationId)
}
