import type { PrintSettings } from "@/components/print/types"

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
  blackAndWhite: false,
  pharmaMode: false,
  autoPrintAfterSave: false,
}

export function readStoredPrintSettings() {
  if (typeof window === "undefined") return defaultPrintSettings

  try {
    const stored = window.localStorage.getItem("bezgrow.print-settings")
    return stored ? { ...defaultPrintSettings, ...JSON.parse(stored) } as PrintSettings : defaultPrintSettings
  } catch {
    return defaultPrintSettings
  }
}

export function saveStoredPrintSettings(settings: PrintSettings) {
  if (typeof window === "undefined") return
  window.localStorage.setItem("bezgrow.print-settings", JSON.stringify(settings))
}
