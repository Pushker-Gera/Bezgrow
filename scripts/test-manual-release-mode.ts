import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { classifyReleaseTrust } from "../lib/releases/trust"
import {
  automaticUpdaterAvailable,
  isDesktopUpdateAvailable,
  type DesktopReleaseManifest,
} from "../lib/app-updates"

const signedMac = classifyReleaseTrust({
  available: true,
  platform: "macos",
  signed: true,
  notarized: true,
})
assert.deepEqual(signedMac, {
  productionSigned: true,
  manualInstallAllowed: false,
  trustState: "signed-production",
  releaseMode: "SIGNED_PRODUCTION_RELEASE",
})

const manualMac = classifyReleaseTrust({
  available: true,
  platform: "macos",
  signed: false,
  notarized: false,
})
assert.equal(manualMac.trustState, "unsigned-manual-install")
assert.equal(manualMac.releaseMode, "UNSIGNED_MANUAL_RELEASE")
assert.equal(manualMac.manualInstallAllowed, true)
assert.equal(manualMac.productionSigned, false)

const invalidWindows = classifyReleaseTrust({
  available: false,
  platform: "windows",
  signed: false,
  notarized: false,
})
assert.equal(invalidWindows.trustState, "invalid")
assert.equal(invalidWindows.manualInstallAllowed, false)

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { onLine: true, platform: "MacIntel", userAgent: "macOS" },
})
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __BEZGROW_ARCH__: "x64", location: { hostname: "127.0.0.1" } },
})

const sha256 = "a".repeat(64)
const manualManifest: DesktopReleaseManifest = {
  version: "0.1.14",
  macX64: {
    version: "0.1.14",
    platform: "macos",
    architecture: "x86_64",
    downloadUrl: "https://www.bezgrow.com/api/downloads/desktop?platform=mac",
    filename: "Bezgrow-0.1.14-x64.dmg",
    size: 80 * 1024 * 1024,
    sha256,
    checksumVerified: true,
    metadataValid: true,
    signed: false,
    notarized: false,
    trustState: "unsigned-manual-install",
    releaseMode: "UNSIGNED_MANUAL_RELEASE",
    productionSigned: false,
    manualInstallAllowed: true,
  },
}
assert.equal(
  isDesktopUpdateAvailable(manualManifest, "0.1.13"),
  true,
  "A genuine manual-install release must remain discoverable as an update."
)
assert.equal(
  isDesktopUpdateAvailable(manualManifest, "0.1.14"),
  false,
  "The installed version must not update to itself."
)
assert.equal(automaticUpdaterAvailable(manualManifest.macX64), false)

manualManifest.macX64!.updaterUrl =
  "https://github.com/Pushker-Gera/Bezgrow/releases/download/v0.1.14/Bezgrow-0.1.14-x64.app.tar.gz"
manualManifest.macX64!.updaterSize = 70 * 1024 * 1024
manualManifest.macX64!.updaterSha256 = "b".repeat(64)
manualManifest.macX64!.updaterSignature = "verified-minisign-signature"
manualManifest.macX64!.updaterSignatureVerified = true
assert.equal(
  automaticUpdaterAvailable(manualManifest.macX64),
  true,
  "Tauri updater integrity must remain independent of Apple notarization."
)

const nativeSource = readFileSync("src-tauri/src/lib.rs", "utf8")
const updatePanelSource = readFileSync("components/AppUpdatesPanel.tsx", "utf8")
assert.match(nativeSource, /desktop_download_verified_release/, "Verified assisted download command is missing.")
assert.match(nativeSource, /x-bezgrow-artifact-sha256/, "Assisted updates must bind the response to metadata SHA-256.")
assert.match(nativeSource, /digest\.finalize\(\)/, "Assisted updates must hash the complete downloaded installer.")
assert.match(nativeSource, /parsed\.path\(\) != "\/api\/downloads\/desktop"/, "Assisted updates must use only the trusted Bezgrow endpoint.")
assert.doesNotMatch(nativeSource, /xattr|spctl --master-disable|Set-MpPreference/, "Native update code must not weaken OS security.")
assert.match(updatePanelSource, /Verified assisted installer/, "Unsigned releases must be labelled as verified assisted installers.")
assert.doesNotMatch(
  updatePanelSource,
  /updateAvailable\s*&&\s*!updatePostponed/,
  "Reminder deferral must not hide the user-requested Update Now action in Settings."
)

const trackedFeatureFiles = execFileSync("git", ["ls-files", "app", "components", "lib"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((filename) => !/release|update|download/i.test(filename))
for (const filename of trackedFeatureFiles) {
  const source = readFileSync(filename, "utf8")
  assert.doesNotMatch(
    source,
    /isNotarized|isAuthenticodeSigned|productionCertificateAvailable|UNSIGNED_MANUAL_RELEASE/,
    filename + " incorrectly couples application functionality to platform signing."
  )
}

console.log("manual-release-mode-ok trust=explicit updater-integrity=independent assisted-download=verified erp-signing-coupling=absent")
