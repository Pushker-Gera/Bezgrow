import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, join, resolve } from "node:path"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] || fallback : fallback
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function filesUnder(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(filename))
    else files.push(filename)
  }
  return files
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex")
}

const root = resolve(arg("--root", "release-artifacts"))
const releaseJsonPath = resolve(arg("--release-json"))
const expectedTag = arg("--tag")
const expectedVersion = arg("--version")
const expectedCommit = arg("--commit")

assert(existsSync(root), `Release artifact root is missing: ${root}`)
assert(existsSync(releaseJsonPath), "GitHub release API metadata is missing.")
assert(expectedTag, "--tag is required.")
assert(/^\d+\.\d+\.\d+$/.test(expectedVersion), "--version must be a stable semantic version.")
assert(/^[a-f0-9]{40}$/i.test(expectedCommit), "--commit must be a complete source commit.")

const release = JSON.parse(readFileSync(releaseJsonPath, "utf8"))
assert(release.tag_name === expectedTag, `GitHub release tag ${release.tag_name} does not match ${expectedTag}.`)
assert(release.draft === false, "Public release URL verification cannot use a draft GitHub release.")
assert(
  release.target_commitish === expectedCommit,
  `GitHub release targets ${release.target_commitish || "(missing)"}, not ${expectedCommit}.`
)
assert(Array.isArray(release.assets), "GitHub release API metadata contains no assets.")

const uploadedAssets = new Map()
for (const asset of release.assets) {
  assert(!uploadedAssets.has(asset.name), `GitHub release contains duplicate asset ${asset.name}.`)
  uploadedAssets.set(asset.name, asset)
}

const publishable = filesUnder(root).filter((filename) =>
  /(?:\.dmg|\.exe|\.msi|\.msix|\.zip|\.tar\.gz|\.sig|SHA256SUMS\.txt|-build\.json)$/i.test(filename)
)
assert(publishable.length > 0, "No publishable release assets were found.")

const localNames = new Set()
for (const filename of publishable) {
  const name = basename(filename)
  assert(!localNames.has(name), `Multiple local assets use the release filename ${name}.`)
  localNames.add(name)
  const remote = uploadedAssets.get(name)
  assert(remote, `GitHub release is missing uploaded asset ${name}.`)
  const size = statSync(filename).size
  const digest = `sha256:${sha256(filename)}`
  assert(size > 0, `Local release asset ${name} is empty.`)
  assert(remote.size === size, `GitHub asset ${name} size ${remote.size} does not match ${size}.`)
  assert(remote.digest === digest, `GitHub asset ${name} digest does not match the final uploaded bytes.`)
  assert(remote.state === "uploaded", `GitHub asset ${name} is not in the uploaded state.`)
  assert(
    typeof remote.browser_download_url === "string" &&
      remote.browser_download_url.includes(`/releases/download/${expectedTag}/`) &&
      remote.browser_download_url.endsWith(`/${name}`),
    `GitHub asset ${name} does not have the immutable ${expectedTag} download URL.`
  )
}

const installers = publishable.filter((filename) => /\.(?:dmg|exe|msi|msix)$/i.test(filename))
assert(
  installers.some((filename) => new RegExp(`^Bezgrow-${expectedVersion}-(?:arm64|x64)\\.dmg$`).test(basename(filename))),
  "The public release is missing its versioned macOS DMG."
)
assert(
  installers.some((filename) => basename(filename) === `Bezgrow-Setup-${expectedVersion}-x64.exe`),
  "The public release is missing its genuine Windows NSIS installer."
)
assert(
  installers.some((filename) => basename(filename) === `Bezgrow-${expectedVersion}-x64.msi`),
  "The public release is missing its genuine Windows MSI installer."
)

for (const filename of installers) {
  const name = basename(filename)
  const asset = uploadedAssets.get(name)
  const response = await fetch(asset.browser_download_url, {
    method: "HEAD",
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  })
  assert(response.status === 200, `Public URL for ${name} returned HTTP ${response.status}.`)
  const contentType = (response.headers.get("content-type") || "").toLowerCase()
  assert(
    !contentType.includes("text/html") &&
      !contentType.includes("application/json") &&
      !contentType.startsWith("text/"),
    `Public URL for ${name} returned ${contentType || "an unknown content type"}.`
  )
  const reportedSize = Number(response.headers.get("content-length") || 0)
  if (reportedSize > 0) {
    assert(reportedSize === asset.size, `Public URL for ${name} reports ${reportedSize} bytes instead of ${asset.size}.`)
  }
}

console.log(JSON.stringify({
  verification: "published-release-assets-valid",
  tag: expectedTag,
  version: expectedVersion,
  sourceCommit: expectedCommit,
  verifiedAssetDigests: publishable.length,
  verifiedInstallerUrls: installers.length,
}, null, 2))
