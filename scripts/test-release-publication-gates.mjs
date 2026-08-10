import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (filename) => readFileSync(filename, "utf8")
const packageJson = JSON.parse(read("package.json"))
const workflow = read(".github/workflows/desktop-release.yml")
const publisher = read("scripts/verify-release-publication-inputs.mjs")
const writer = read("scripts/write-desktop-release-manifest.mjs")

assert.match(workflow, /release-gates:\s*[\s\S]*npm run test:release-gates/, "Desktop publication must depend on explicit local-first release gates.")
assert.match(workflow, /mac:\s*[\s\S]*needs:\s*release-gates/, "The Mac build must require the release-gate job.")
assert.match(workflow, /windows:\s*[\s\S]*needs:\s*release-gates/, "The Windows build must require the release-gate job.")
assert.match(workflow, /runs-on:\s*windows-latest[\s\S]*--bundles", "msi,nsis"/, "Genuine Windows x64 NSIS and MSI builds must run on windows-latest.")
assert.match(workflow, /needs\.mac\.result == 'success' &&[\s\S]*needs\.windows\.result == 'success'/, "Publication must require both platform builds from the same workflow.")
assert.match(publisher, /verifiedPlatforms\.includes\("macos"\)[\s\S]*verifiedPlatforms\.includes\("windows-x64-nsis-msi"\)/, "Publication input verification must reject partial platform releases.")
assert.match(workflow, /Compute release checksums[\s\S]*Verify genuine publication inputs[\s\S]*Create or update GitHub Release/, "Checksums and installer bytes must pass before GitHub Release mutation.")
assert.match(workflow, /verify-release-publication-inputs\.mjs/, "The release workflow must execute the publication input verifier.")
assert.match(publisher, /\["nsis", "msi"\]/, "Publication must require both NSIS and MSI records.")
assert.match(publisher, /Recorded Windows artifact SHA-256 mismatch/, "Publication must compare Windows provenance checksums.")
assert.match(publisher, /Unrecorded Windows release asset is blocked/, "Publication must reject unrecorded Windows installer files.")
assert.match(publisher, /No checksum was recorded/, "Every release file must be checksum-gated.")
assert.match(publisher, /verify-release-artifact\.mjs/, "Publication must revalidate genuine installer bytes.")
assert.match(publisher, /immutable versioned name/, "Mac publication must require a versioned immutable DMG filename.")
assert.match(publisher, /sourceCommit/, "Mac publication must verify source-commit provenance.")
assert.match(writer, /Published release metadata requires a local verified installer file/, "Published metadata must fail closed without a local installer.")
assert.match(writer, /Bezgrow-mac\.dmg\.release\.json/, "Publication must write the Mac sidecar manifest.")
assert.match(writer, /buildTimestamp/, "Published artifacts must record their build timestamp.")
assert.match(workflow, /mac-build\.json/, "The Mac release must carry a checked build-provenance record.")
assert.match(workflow, /Automatic mode sends only this explicitly selected invoice PDF/, "Mac artifact staging must verify the current professional invoice-delivery UI.")
assert.doesNotMatch(workflow, /The exact previewed invoice PDF remains on this device/, "Mac artifact staging must not require obsolete invoice-share copy.")

const releaseGateScript = packageJson.scripts["test:release-gates"] || ""
for (const required of [
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
