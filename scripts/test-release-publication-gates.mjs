import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (filename) => readFileSync(filename, "utf8")
const packageJson = JSON.parse(read("package.json"))
const workflow = read(".github/workflows/desktop-release.yml")
const publisher = read("scripts/verify-release-publication-inputs.mjs")
const writer = read("scripts/write-desktop-release-manifest.mjs")
const metadataPublisher = read("scripts/publish-release-metadata.mjs")
const publicAssetVerifier = read("scripts/verify-published-release-assets.mjs")

assert.match(workflow, /release-gates:\s*[\s\S]*npm run test:release-gates/, "Desktop publication must depend on explicit local-first release gates.")
assert.match(workflow, /mac:\s*[\s\S]*needs:\s*release-gates/, "The Mac build must require the release-gate job.")
assert.match(workflow, /Verify packaged Mac launch, local SQLite, and clean shutdown[\s\S]*test:desktop-lifecycle:mac/, "The Mac artifact must pass a real packaged launch, SQLite, and shutdown lifecycle before publication.")
assert.match(workflow, /Download and verify the previously published Windows installer[\s\S]*PreviousInstallerPath/, "Windows release CI must test an in-place upgrade from the checksum-pinned previous public version.")
assert.match(workflow, /windows:\s*[\s\S]*needs:\s*release-gates/, "The Windows build must require the release-gate job.")
assert.match(workflow, /runs-on:\s*windows-latest[\s\S]*--bundles", "msi,nsis"/, "Genuine Windows x64 NSIS and MSI builds must run on windows-latest.")
assert.match(workflow, /needs\.mac\.result == 'success' &&[\s\S]*needs\.windows\.result == 'success'/, "Publication must require both platform builds from the same workflow.")
assert.match(publisher, /verifiedPlatforms\.includes\("macos"\)[\s\S]*verifiedPlatforms\.includes\("windows-x64-nsis-msi"\)/, "Publication input verification must reject partial platform releases.")
assert.match(workflow, /Compute release checksums[\s\S]*Verify genuine publication inputs[\s\S]*Create or update GitHub Release/, "Checksums and installer bytes must pass before GitHub Release mutation.")
assert.match(workflow, /Create or update GitHub Release[\s\S]*Verify uploaded digests and public installer URLs[\s\S]*Write verified website release metadata/, "Public URLs and uploaded digests must pass before website metadata advances.")
assert.match(workflow, /verify-release-publication-inputs\.mjs/, "The release workflow must execute the publication input verifier.")
assert.match(publisher, /\["nsis", "msi"\]/, "Publication must require both NSIS and MSI records.")
assert.match(publisher, /Recorded Windows artifact SHA-256 mismatch/, "Publication must compare Windows provenance checksums.")
assert.match(publisher, /Unrecorded Windows release asset is blocked/, "Publication must reject unrecorded Windows installer files.")
assert.match(publisher, /No checksum was recorded/, "Every release file must be checksum-gated.")
assert.match(publisher, /verify-release-artifact\.mjs/, "Publication must revalidate genuine installer bytes.")
assert.match(publisher, /immutable versioned name/, "Mac publication must require a versioned immutable DMG filename.")
assert.match(publisher, /sourceCommit/, "Mac publication must verify source-commit provenance.")
assert.match(publisher, /expectedCommit[\s\S]*Windows build commit/, "Publication must require Mac and Windows artifacts from the requested commit.")
assert.match(writer, /Published release metadata requires a local verified installer file/, "Published metadata must fail closed without a local installer.")
assert.match(publicAssetVerifier, /remote\.digest === digest/, "Published GitHub asset digests must match the final local bytes.")
assert.match(publicAssetVerifier, /response\.status === 200/, "Published installer URLs must return HTTP 200 before metadata advances.")
assert.match(metadataPublisher, /release_status: "draft"[\s\S]*stagedReleases[\s\S]*\.in\("id", releaseIds\)/, "Control-plane releases must stage all artifacts before one multi-platform promotion.")
assert.match(metadataPublisher, /supportsColumns[\s\S]*supportsMandatoryAfter[\s\S]*supportsUpdaterMetadata/, "Control-plane publication must safely detect optional release-schema migrations.")
assert.match(metadataPublisher, /supportsReleaseProvenance[\s\S]*build_commit:[\s\S]*build_timestamp:/, "Control-plane publication must persist the exact installer build SHA and timestamp.")
assert.match(metadataPublisher, /entry\.channel !== "internal"[\s\S]*!supportsUpdaterMetadata/, "Stable updater publication must fail closed when updater schema columns are unavailable.")
assert.match(writer, /Bezgrow-mac\.dmg\.release\.json/, "Publication must write the Mac sidecar manifest.")
assert.match(writer, /buildTimestamp/, "Published artifacts must record their build timestamp.")
assert.match(workflow, /mac-build\.json/, "The Mac release must carry a checked build-provenance record.")
assert.match(workflow, /desktop-runtime\\next-server\\public\\desktop-build\.json/, "The Windows release must verify its embedded build identity.")
assert.match(workflow, /verify-packaged-invoice-delivery\.mjs/, "Mac artifact staging must verify the packaged professional invoice-delivery implementation.")
assert.doesNotMatch(workflow, /The exact previewed invoice PDF remains on this device/, "Mac artifact staging must not require obsolete invoice-share copy.")

const releaseGateScript = packageJson.scripts["test:release-gates"] || ""
for (const required of [
  "test:release-version-alignment",
  "test:production-polish",
  "test:money-card-layout",
  "test:architecture",
  "test:data-authority:ci",
  "test:admin-control-plane",
  "test:license",
  "test:desktop-sqlite-regression",
  "test:desktop-hardening",
  "test:offline",
  "test:final-offline-network",
  "test:backup",
  "test:invoice-print",
  "test:updater",
]) {
  assert.match(releaseGateScript, new RegExp(required.replace(":", "\\:")), `Release gates do not run ${required}.`)
}

console.log("release-publication-gates-ok")
