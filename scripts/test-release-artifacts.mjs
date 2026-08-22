import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
const trustModel = read("lib/releases/trust.ts")
const desktopReleaseRoute = read("app/api/desktop-release/route.ts")
const desktopDownloadRoute = read("app/api/downloads/desktop/route.ts")
const downloadPage = read("app/download/page.tsx")
const releaseWorkflow = read(".github/workflows/desktop-release.yml")
const releaseManifestWriter = read("scripts/write-desktop-release-manifest.mjs")
const publication = read("scripts/publish-release-metadata.mjs")
const productionWindowsVerifier = read("scripts/verify-production-windows-download.mjs")
const productionMacVerifier = read("scripts/verify-production-mac-download.mjs")
const desktopBuild = read("scripts/build-desktop.mjs")

for (const field of [
  "available",
  "signed",
  "notarized",
  "checksumVerified",
  "metadataValid",
  "productionRecommended",
  "productionSigned",
  "manualInstallAllowed",
  "trustState",
  "releaseMode",
  "warning",
  "blockedReason",
]) {
  assert.match(validator, new RegExp(field), `Independent release status is missing: ${field}`)
}
assert.match(validator, /trailingBytes\.includes\(Buffer\.from\("koly"\)\)/, "DMG trailer validation is missing.")
assert.match(validator, /peArchitecture\(firstBytes\)/, "Windows PE validation is missing.")
assert.match(validator, /Buffer\.from\(\[0x50, 0x45, 0, 0\]\)/, "Windows PE signature validation is missing.")
assert.match(validator, /machine === 0x8664/, "Windows x64 machine validation is missing.")
assert.match(validator, /machine === 0x14c/, "Windows installer bootstrap PE validation is missing.")
assert.match(
  validator,
  /is32BitInstallerBootstrap[\s\S]*-setup[\s\S]*portable/,
  "32-bit NSIS bootstrap allowance must be limited to setup and portable installer wrappers."
)
assert.match(validator, /application\/json/, "HTML/JSON installer rejection is missing.")
assert.match(validator, /function inferredVersion[\s\S]*\\d\+\\\.\\d\+\\\.\\d\+[\s\S]*\?=\[-_\.\]/, "Version parsing must stop before the x64 filename suffix.")
assert.match(validator, /Installer SHA-256 does not match release metadata/, "Checksum mismatch must block downloads.")
assert.match(validator, /does not contain metadata version/, "Unversioned physical installer filenames must be rejected.")
assert.match(validator, /commitLike\(candidate\.buildCommit\)/, "Downloads must require an immutable source commit.")
assert.match(validator, /timestampLike\(candidate\.buildTimestamp\)/, "Downloads must require an immutable build timestamp.")
assert.match(validator, /const available = checksumVerified && metadataValid/, "Downloads must require both verified bytes and complete immutable metadata.")
assert.match(validator, /Installer architecture .* does not match metadata architecture/, "Architecture mismatch must block downloads.")
assert.match(publicReleaseSource, /checkedInCandidates/, "Local public/downloads artifacts must be discovered.")
assert.match(publicReleaseSource, /configuredCandidates/, "Configured installer URLs must be discovered.")
assert.match(publicReleaseSource, /filter\(isExplicitlyPublished\)/, "The download page must consider only explicitly published releases.")
assert.match(publicReleaseSource, /allowPublicationAttestation: true/, "Runtime availability must consume publication-time checksum/provenance attestation instead of re-downloading every installer.")
assert.match(publicReleaseSource, /source[\s\S]*version bump must never hide/i, "The source version must not control public installer availability.")
assert.doesNotMatch(publicReleaseSource, /releaseCandidateVersions|newest intended version/, "The obsolete source-version coupling must stay removed.")
assert.match(publicReleaseSource, /metadataService:/, "Control-plane outages must be reported separately from artifact validity.")
assert.match(
  publicReleaseSource,
  /return desktopAvailability\(mac, windows, controlPlaneError\)/,
  "The download page must expose each integrity-verified platform independently."
)
assert.match(desktopReleaseRoute, /platforms:/, "Desktop release API must return independent platform records.")
assert.match(desktopDownloadRoute, /release\.available/, "Download route must gate on integrity availability.")
assert.match(desktopDownloadRoute, /binaryInstallerResponse/, "Validated installers must be returned as binary responses.")
assert.match(desktopDownloadRoute, /status:\s*200/, "Validated installer responses must return HTTP 200.")
assert.doesNotMatch(desktopDownloadRoute, /signed\s*!==\s*true|notarized\s*!==\s*true/, "Download route must not block solely on trust status.")
assert.match(downloadPage, /available:\s*release\.available/, "Download buttons must use independent integrity availability.")
assert.match(
  validator,
  /Manual installation build\. This version is not yet Apple-notarized\./,
  "macOS manual-install warning is missing."
)
assert.match(
  validator,
  /Manual installation build\. This version is not yet digitally signed with a production Windows certificate\./,
  "Windows manual-install warning is missing."
)
assert.match(validator, /trustState:\s*"invalid"/, "Invalid artifacts must have an explicit invalid trust state.")
assert.match(trustModel, /"unsigned-manual-install"/, "Valid unsigned artifacts must have a manual-install trust state.")
assert.match(validator, /isTrustedBezgrowArtifactUrl/, "Artifact URLs must be restricted to trusted Bezgrow release locations.")
assert.match(downloadPage, /Manual installation release/, "The download page must label manual installation releases.")
assert.match(downloadPage, /right-click the Bezgrow app, choose Open/, "macOS right-click Open guidance is missing.")
assert.match(desktopDownloadRoute, /application\/x-apple-diskimage/, "DMG content type is not explicit.")
assert.match(desktopDownloadRoute, /Content-Disposition/, "DMG download filename is not explicit.")
assert.match(desktopDownloadRoute, /Installer integrity error: metadata expects/, "Download route must reject source-size drift before streaming bytes.")
assert.match(desktopDownloadRoute, /X-Bezgrow-Artifact-Sha256/, "Download responses must identify the exact verified checksum.")
assert.match(desktopDownloadRoute, /X-Bezgrow-Artifact-Version/, "Download responses must identify the exact installer version.")
assert.match(downloadPage, /Not notarized/, "The Mac download metadata must show notarization status separately.")
assert.match(releaseWorkflow, /runs-on:\s*windows-latest/, "Windows installer must build on windows-latest.")
assert.match(releaseWorkflow, /verify-release-artifact\.mjs/, "Workflow must validate installer bytes.")
assert.match(releaseWorkflow, /Compute release checksums/, "Workflow must calculate SHA-256 checksums.")
assert.match(releaseWorkflow, /manual installation/i, "Workflow must clearly label unsigned builds as manual installation releases.")
assert.match(
  releaseWorkflow,
  /security import "\$CERTIFICATE_PATH"[\s\S]*HAS_SIGNING=true/,
  "Workflow must prove the Apple PKCS#12 identity is importable before selecting a signed build."
)
assert.match(
  releaseWorkflow,
  /-u APPLE_CERTIFICATE[\s\S]*npm run desktop:build:mac/,
  "An invalid Apple signing configuration must be removed before the manual Mac build."
)
assert.doesNotMatch(
  releaseWorkflow,
  /-u TAURI_SIGNING_PRIVATE_KEY|-u BEZGROW_UPDATER_PUBLIC_KEY/,
  "Updater signing credentials must remain independent of Apple signing and notarization."
)
assert.match(
  releaseWorkflow,
  /if \[ -f "\$METADATA_FILE" \]; then git add "\$METADATA_FILE"; fi/,
  "Platform-specific metadata publication must stage only sidecars that the successful artifact jobs produced."
)
assert.doesNotMatch(releaseWorkflow, /Stable publication and public downloads remain disabled/, "Unsigned builds must not disable real downloads.")
assert.doesNotMatch(releaseWorkflow, /gh release upload[^\n]*--clobber/, "Versioned release assets must never be silently replaced.")
assert.match(releaseWorkflow, /cmp -s[\s\S]*Immutable release asset/, "Existing release assets must be byte-identical before reuse.")
assert.match(releaseManifestWriter, /productionRecommended/, "Manifest writer must separate availability from production trust.")
assert.match(publication, /can only be published as a manual installation release/, "Unsigned CI metadata must be explicitly restricted to manual installation.")
assert.match(publication, /signature_status: installer\.signed === true \? "valid" : "invalid"/, "CI metadata must preserve signing truth.")
assert.match(
  desktopBuild,
  /if \(publicMacBuild && existsSync\(dmgPath\)\)/,
  "An internal macOS build must never replace public download artifacts."
)
assert.match(
  desktopBuild,
  /function preserveMacAppBundle[\s\S]*requestedBundles\.includes\("dmg"\)[\s\S]*"app"/,
  "DMG builds must explicitly retain the independently launchable macOS app bundle."
)
assert.match(
  desktopBuild,
  /if \(publicWindowsBuild && existsSync\(windowsExePath\)\)/,
  "An internal Windows build must never replace public download artifacts."
)
assert.match(productionWindowsVerifier, /method: "GET"/, "Production verification must download the complete installer with GET.")
assert.match(productionWindowsVerifier, /createHash\("sha256"\)/, "Production verification must hash downloaded installer bytes.")
assert.match(productionWindowsVerifier, /installer\?\.buildCommit !== expectedCommit/, "Production Windows verification must require the exact source commit.")
assert.match(productionWindowsVerifier, /peArchitecture\(firstBytes\)/, "Production verification must validate a real PE executable.")
assert.match(productionWindowsVerifier, /releases\\\/download/, "Production verification must require durable GitHub Release storage.")
assert.match(productionMacVerifier, /method: "GET"/, "Production Mac verification must download the complete installer with GET.")
assert.match(productionMacVerifier, /hdiutil/, "Production Mac verification must mount the downloaded DMG.")
assert.match(productionMacVerifier, /bundledPrivateDataFiles:\s*0/, "Mounted DMG verification must reject bundled SQLite, license, Device ID, and runtime data.")
assert.match(productionMacVerifier, /Create secure share link/, "Production Mac verification must reject the obsolete sharing implementation.")
assert.match(productionMacVerifier, /prepared separately/, "Production Mac verification must reject the exact stale invoice-sharing copy.")
assert.match(productionMacVerifier, /Please find your invoice summary below\./, "Production Mac verification must require the professional WhatsApp message.")
assert.match(productionMacVerifier, /Platform Admin Login/, "Production Mac verification must require the device-authorized admin launcher.")
assert.match(productionMacVerifier, /installer\.buildCommit/, "Production Mac verification must match release metadata to the embedded commit.")
assert.match(productionMacVerifier, /desktop_open_pdf_for_print/, "Production Mac verification must require the canonical native print command.")

const peFixtureDirectory = mkdtempSync(join(tmpdir(), "bezgrow-pe-validator-"))
try {
  const nsisStub = Buffer.alloc(1024 * 1024)
  nsisStub.write("MZ", 0, "ascii")
  nsisStub.writeUInt32LE(0x80, 0x3c)
  nsisStub.write("PE\u0000\u0000", 0x80, "binary")
  nsisStub.writeUInt16LE(0x14c, 0x84)
  const setupFixture = join(peFixtureDirectory, "Bezgrow-Setup-0.1.7-x64.exe")
  const nativeFixture = join(peFixtureDirectory, "Bezgrow-0.1.7-x64.exe")
  writeFileSync(setupFixture, nsisStub)
  writeFileSync(nativeFixture, nsisStub)

  const setupVerification = spawnSync(
    process.execPath,
    [
      "scripts/verify-release-artifact.mjs",
      "--file",
      setupFixture,
      "--platform",
      "windows",
      "--architecture",
      "x64",
      "--version",
      "0.1.7",
    ],
    { encoding: "utf8" }
  )
  assert.equal(setupVerification.status, 0, setupVerification.stderr || "NSIS x86 bootstrap validation failed.")

  const staleSetupFixture = join(peFixtureDirectory, "Bezgrow-Setup-0.1.9-x64.exe")
  writeFileSync(staleSetupFixture, nsisStub)
  const staleSetupVerification = spawnSync(
    process.execPath,
    [
      "scripts/verify-release-artifact.mjs",
      "--file",
      staleSetupFixture,
      "--platform",
      "windows",
      "--architecture",
      "x64",
      "--version",
      "0.1.10",
    ],
    { encoding: "utf8" }
  )
  assert.notEqual(staleSetupVerification.status, 0, "A 0.1.9 installer must never satisfy 0.1.10 metadata.")
  assert.match(
    staleSetupVerification.stderr,
    /Installer version 0\.1\.9 does not match 0\.1\.10/,
    "Old-version installer rejection must identify the exact mismatch."
  )

  const nativeVerification = spawnSync(
    process.execPath,
    [
      "scripts/verify-release-artifact.mjs",
      "--file",
      nativeFixture,
      "--platform",
      "windows",
      "--architecture",
      "x64",
      "--version",
      "0.1.7",
    ],
    { encoding: "utf8" }
  )
  assert.notEqual(nativeVerification.status, 0, "An x86 native executable must not be accepted as x64.")
} finally {
  rmSync(peFixtureDirectory, { recursive: true, force: true })
}

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
const windowsManifestKeys = [
  "windows",
  "windowsMsi",
  "windowsMsix",
  "windowsArm64",
  "windowsArm64Msi",
  "windowsArm64Msix",
  "windowsPortable",
  "windowsPortableZip",
  "windowsArm64Portable",
  "windowsArm64PortableZip",
]
const publishedWindowsEntries = windowsManifestKeys
  .map((key) => [key, manifest[key]])
  .filter(([, installer]) => Boolean(installer))

if (!genuineWindowsExists) {
  for (const [key, installer] of publishedWindowsEntries) {
    assert.equal(installer.platform, "windows", `Published artifact ${key} must identify Windows.`)
    assert.match(
      installer.downloadUrl || "",
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//,
      `Published artifact ${key} must use a concrete GitHub Release URL.`
    )
    assert.ok(installer.size > 1024 * 1024, `Published artifact ${key} must include a realistic byte size.`)
    assert.match(installer.sha256 || "", /^[a-f0-9]{64}$/i, `Published artifact ${key} must include SHA-256.`)
    assert.equal(installer.available, true, `Published artifact ${key} must be available.`)
    assert.equal(installer.checksumVerified, true, `Published artifact ${key} must be checksum-verified.`)
    assert.equal(installer.metadataValid, true, `Published artifact ${key} must have valid metadata.`)
  }
}

console.log(
  `release-artifacts-ok mac=${Boolean(manifest.mac)} windows=${genuineWindowsExists || publishedWindowsEntries.length > 0}`
)
