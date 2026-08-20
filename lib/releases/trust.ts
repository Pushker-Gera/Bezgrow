export type ReleaseTrustState = "signed-production" | "unsigned-manual-install" | "invalid"
export type ReleaseMode = "SIGNED_PRODUCTION_RELEASE" | "UNSIGNED_MANUAL_RELEASE" | "INVALID_RELEASE"

export type ReleaseTrust = {
  productionSigned: boolean
  manualInstallAllowed: boolean
  trustState: ReleaseTrustState
  releaseMode: ReleaseMode
}

export function classifyReleaseTrust(input: {
  available: boolean
  platform: "macos" | "windows"
  signed: boolean
  notarized: boolean
}): ReleaseTrust {
  const productionSigned = Boolean(
    input.available &&
      input.signed &&
      (input.platform === "windows" || input.notarized)
  )
  const manualInstallAllowed = Boolean(input.available && !productionSigned)
  return {
    productionSigned,
    manualInstallAllowed,
    trustState: productionSigned
      ? "signed-production"
      : manualInstallAllowed
        ? "unsigned-manual-install"
        : "invalid",
    releaseMode: productionSigned
      ? "SIGNED_PRODUCTION_RELEASE"
      : manualInstallAllowed
        ? "UNSIGNED_MANUAL_RELEASE"
        : "INVALID_RELEASE",
  }
}

export function isManualReleaseChannel(value: string | null | undefined) {
  return value === "manual" || value === "internal"
}
