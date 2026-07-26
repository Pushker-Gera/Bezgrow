import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"

const read = (path) => readFileSync(path, "utf8")
const readJson = (path) => JSON.parse(read(path))
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")

const desktopManifestPath = "public/downloads/desktop-release.json"
assert.ok(existsSync(desktopManifestPath), "Desktop release manifest is missing.")
const manifest = readJson(desktopManifestPath)
assert.ok(manifest.version, "Desktop release manifest version is missing.")

const publicReleaseSource = read("lib/releases/public.ts")
const validator = read("lib/releases/artifact-validation.ts")
const desktopReleaseRoute = read("app/api/desktop-release/route.ts")
const desktopDownloadRoute = read("app/api/downloads/desktop/route.ts")
const downloadPage = read("app/download/page.tsx")
const nextConfig = read("next.config.ts")
const releaseWorkflow = read(".github/workflows/desktop-release.yml")
const releaseManifestWriter = read("scripts/write-desktop-release-manifest.mjs")
const publication = read("scripts/publish-release-metadata.mjs")

for (const field of [
  "available",
  "signed",
  "notarized",
  "checksumVerified",
  "metadataValid",
  "productionRecommended",
  "warning",
  "blockedReason",
]) {
  assert.match(validator, new RegExp(field), `Independent release status is missing: ${field}`)
}
assert.match(validator, /trailingBytes\.includes\(Buffer\.from\("koly"\)\)/, "DMG trailer validation is missing.")
assert.match(validator, /toString\("ascii"\) === "MZ"/, "Windows PE validation is missing.")
assert.match(validator, /application\/json/, "HTML/JSON installer rejection is missing.")
assert.match(validator, /Installer SHA-256 does not match release metadata/, "Checksum mismatch must block downloads.")
assert.match(validator, /Installer architecture .* does not match metadata architecture/, "Architecture mismatch must block downloads.")
assert.match(publicReleaseSource, /checkedInCandidates/, "Local public/downloads artifacts must be discovered.")
assert.match(publicReleaseSource, /configuredCandidates/, "Configured installer URLs must be discovered.")
assert.match(desktopReleaseRoute, /platforms:/, "Desktop release API must return independent platform records.")
assert.match(desktopDownloadRoute, /release\.available/, "Download route must gate on integrity availability.")
assert.doesNotMatch(desktopDownloadRoute, /signed\s*!==\s*true|notarized\s*!==\s*true/, "Download route must not block solely on trust status.")
assert.match(downloadPage, /available:\s*release\.available/, "Download buttons must use independent integrity availability.")
assert.match(
  validator,
  /Internal\/testing build: this macOS installer is not notarized and macOS may show a security warning\./,
  "macOS internal-build warning is missing."
)
assert.match(
  validator,
  /Internal\/testing build: Windows SmartScreen may display a warning because this installer is not code-signed\./,
  "Windows internal-build warning is missing."
)
assert.match(downloadPage, /right-click the Bezgrow app, choose Open/, "macOS right-click Open guidance is missing.")
assert.match(nextConfig, /application\/x-apple-diskimage/, "DMG content type is not explicit.")
assert.match(nextConfig, /Content-Disposition[\s\S]*Bezgrow-mac\.dmg/, "DMG download filename is not explicit.")
assert.match(releaseWorkflow, /runs-on:\s*windows-latest/, "Windows installer must build on windows-latest.")
assert.match(releaseWorkflow, /verify-release-artifact\.mjs/, "Workflow must validate installer bytes.")
assert.match(releaseWorkflow, /Compute release checksums/, "Workflow must calculate SHA-256 checksums.")
assert.match(releaseWorkflow, /internal\/testing/, "Workflow must clearly label unsigned builds as internal/testing.")
assert.doesNotMatch(releaseWorkflow, /Stable publication and public downloads remain disabled/, "Unsigned builds must not disable real downloads.")
assert.match(releaseManifestWriter, /productionRecommended/, "Manifest writer must separate availability from production trust.")
assert.match(publication, /can only be published as an internal\/testing release/, "Unsigned CI metadata must be restricted to internal/testing.")
assert.match(publication, /signature_status: installer\.signed === true \? "valid" : "invalid"/, "CI metadata must preserve signing truth.")

if (manifest.mac?.file) {
  const macPath = `public${manifest.mac.file}`
  assert.ok(existsSync(macPath), "Mac installer listed in manifest is missing.")
  assert.equal(statSync(macPath).size, manifest.mac.size, "Mac installer size does not match manifest.")
  assert.equal(sha256(macPath), manifest.mac.sha256, "Mac installer SHA-256 does not match manifest.")
  assert.equal(manifest.mac.available, true, "Verified Mac installer must be marked available.")
  assert.equal(manifest.mac.signed, false, "Current ad-hoc Mac build must not be called production-signed.")
  assert.equal(manifest.mac.notarized, false, "Current Mac build must not be called notarized.")
  assert.equal(manifest.mac.checksumVerified, true, "Current Mac checksum must be verified.")
  assert.equal(manifest.mac.productionRecommended, false, "Current internal Mac build must not be production-recommended.")
  const verification = spawnSync(
    process.execPath,
    [
      "scripts/verify-release-artifact.mjs",
      "--file",
      macPath,
      "--platform",
      "macos",
      "--architecture",
      manifest.mac.architecture,
      "--version",
      manifest.mac.version,
      "--size",
      String(manifest.mac.size),
      "--sha256",
      manifest.mac.sha256,
    ],
    { encoding: "utf8" }
  )
  assert.equal(verification.status, 0, verification.stderr || "Mac installer byte validation failed.")
}

const windowsFiles = [
  "public/downloads/Bezgrow-windows.exe",
  "public/downloads/Bezgrow-windows.msi",
  "public/downloads/Bezgrow-windows.msix",
]
const genuineWindowsExists = windowsFiles.some(existsSync)
if (!genuineWindowsExists) {
  for (const key of ["windows", "windowsMsi", "windowsMsix", "windowsArm64", "windowsArm64Msi", "windowsArm64Msix"]) {
    assert.equal(manifest[key], undefined, `Manifest must not invent missing Windows artifact ${key}.`)
  }
}

console.log(`release-artifacts-ok mac=${Boolean(manifest.mac)} windows=${genuineWindowsExists}`)
