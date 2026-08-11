import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import process from "node:process"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1] || fallback
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex")
}

function filesUnder(directory) {
  const output = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...filesUnder(filename))
    else output.push(filename)
  }
  return output
}

function verifyArtifact(filename, platform, architecture, version) {
  const result = spawnSync(process.execPath, [
    "scripts/verify-release-artifact.mjs",
    "--file", filename,
    "--platform", platform,
    "--architecture", architecture,
    "--version", version,
  ], { cwd: process.cwd(), encoding: "utf8" })
  assert(result.status === 0, result.stderr || result.stdout || `Artifact verification failed for ${filename}.`)
}

function readStatus(filename, allowed) {
  assert(existsSync(filename), `Required release status file is missing: ${filename}`)
  const value = readFileSync(filename, "utf8").trim().toLowerCase()
  assert(allowed.includes(value), `Unexpected status ${value || "(empty)"} in ${filename}.`)
  return value
}

const root = path.resolve(arg("--root", "release-artifacts"))
const version = arg("--version")
const expectedCommit = arg("--commit")
const checksumFile = path.resolve(arg("--checksums", path.join(root, "SHA256SUMS.txt")))
assert(version, "--version is required.")
assert(/^[a-f0-9]{40}$/i.test(expectedCommit), "--commit must be the exact 40-character source commit.")
assert(existsSync(root), `Release artifact root is missing: ${root}`)
assert(existsSync(checksumFile), `Release checksum file is missing: ${checksumFile}`)

const checksumEntries = new Map()
for (const line of readFileSync(checksumFile, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue
  const match = /^([a-f0-9]{64})\s+(.+)$/i.exec(line)
  assert(match, `Invalid SHA256SUMS line: ${line}`)
  const filename = path.resolve(match[2].replace(/^\*/, ""))
  assert(filename.startsWith(`${root}${path.sep}`), `Checksum path escapes the release root: ${match[2]}`)
  assert(!checksumEntries.has(filename), `Duplicate checksum entry: ${match[2]}`)
  checksumEntries.set(filename, match[1].toLowerCase())
}

const releaseFiles = filesUnder(root).filter((filename) => path.resolve(filename) !== checksumFile)
assert(releaseFiles.length > 0, "No release files were downloaded.")
for (const filename of releaseFiles) {
  assert(checksumEntries.has(path.resolve(filename)), `No checksum was recorded for ${filename}.`)
  assert(sha256(filename) === checksumEntries.get(path.resolve(filename)), `Checksum mismatch for ${filename}.`)
}
assert(checksumEntries.size === releaseFiles.length, "SHA256SUMS contains missing or unverified file entries.")

const verifiedPlatforms = []
const macDirectory = path.join(root, "mac")
if (existsSync(macDirectory)) {
  const dmgFiles = filesUnder(macDirectory).filter((filename) => filename.toLowerCase().endsWith(".dmg"))
  assert(dmgFiles.length === 1, "The macOS artifact set must contain exactly one DMG.")
  const dmg = dmgFiles[0]
  const architecture = readFileSync(path.join(macDirectory, "mac-architecture.txt"), "utf8").trim()
  assert(["arm64", "x64"].includes(architecture), `Unsupported macOS architecture: ${architecture}`)
  const expectedDmgName = `Bezgrow-${version}-${architecture}.dmg`
  assert(path.basename(dmg) === expectedDmgName, `The macOS artifact must use the immutable versioned name ${expectedDmgName}.`)
  const buildManifestPath = path.join(macDirectory, "mac-build.json")
  assert(existsSync(buildManifestPath), "The Mac build provenance manifest is missing.")
  const build = JSON.parse(readFileSync(buildManifestPath, "utf8"))
  assert(build.version === version, `Mac build version ${build.version} does not match ${version}.`)
  assert(build.platform === "macos", "Mac build provenance has the wrong platform.")
  assert(build.architecture === architecture, "Mac build provenance has the wrong architecture.")
  assert(/^[a-f0-9]{40}$/i.test(build.sourceCommit || ""), "Mac build provenance is missing the full source commit.")
  assert(build.sourceCommit === expectedCommit, `Mac build commit ${build.sourceCommit} does not match ${expectedCommit}.`)
  assert(!Number.isNaN(Date.parse(build.builtAt)), "Mac build provenance is missing a valid build timestamp.")
  assert(build.sourceTreeDirty === false, "Mac release provenance reports a dirty source tree.")
  assert(build.artifact?.filename === expectedDmgName, "Mac build provenance has the wrong artifact filename.")
  assert(build.artifact?.bytes === statSync(dmg).size, "Mac build provenance byte size does not match the DMG.")
  assert(build.artifact?.sha256 === sha256(dmg), "Mac build provenance SHA-256 does not match the DMG.")
  readStatus(path.join(macDirectory, "mac-signing-status.txt"), ["true", "false"])
  readStatus(path.join(macDirectory, "mac-notarization-status.txt"), ["true", "false"])
  readStatus(path.join(macDirectory, "mac-updater-status.txt"), ["true", "false"])
  verifyArtifact(dmg, "macos", architecture, version)
  verifiedPlatforms.push("macos")
}

const windowsDirectory = path.join(root, "windows-x64")
if (existsSync(windowsDirectory)) {
  const buildManifestPath = path.join(windowsDirectory, "windows-build.json")
  assert(existsSync(buildManifestPath), "The Windows build provenance manifest is missing.")
  const build = JSON.parse(readFileSync(buildManifestPath, "utf8"))
  assert(build.version === version, `Windows build version ${build.version} does not match ${version}.`)
  assert(build.platform === "windows", "Windows build manifest has the wrong platform.")
  assert(build.architecture === "x86_64", "Windows publication must contain a genuine x64 build.")
  assert(build.buildCommit === expectedCommit, `Windows build commit ${build.buildCommit} does not match ${expectedCommit}.`)
  assert(!Number.isNaN(Date.parse(build.builtAt)), "Windows build provenance is missing a valid build timestamp.")
  assert(build.sourceTreeDirty === false, "Windows release provenance reports a dirty source tree.")
  assert(Array.isArray(build.artifacts), "Windows build manifest has no artifact records.")
  readStatus(path.join(windowsDirectory, "windows-signing-status.txt"), ["valid", "unsigned"])
  readStatus(path.join(windowsDirectory, "windows-updater-status.txt"), ["true", "false"])

  const records = new Map(build.artifacts.map((record) => [record.kind, record]))
  assert(records.size === build.artifacts.length, "Windows build manifest contains duplicate artifact kinds.")
  for (const requiredKind of ["nsis", "msi"]) {
    assert(records.has(requiredKind), `Required genuine Windows ${requiredKind.toUpperCase()} record is missing.`)
  }
  for (const record of build.artifacts) {
    assert(typeof record.filename === "string" && path.basename(record.filename) === record.filename, "Unsafe Windows artifact filename.")
    const filename = path.join(windowsDirectory, record.filename)
    assert(existsSync(filename), `Recorded Windows artifact is missing: ${record.filename}`)
    assert(statSync(filename).size === record.bytes, `Recorded Windows artifact size mismatch: ${record.filename}`)
    assert(sha256(filename) === record.sha256, `Recorded Windows artifact SHA-256 mismatch: ${record.filename}`)
    if (record.kind === "portableZip") {
      assert(readFileSync(filename).subarray(0, 2).toString("binary") === "PK", "Portable ZIP has an invalid header.")
    } else {
      verifyArtifact(filename, "windows", "x64", version)
    }
  }
  const recordedFiles = new Set(build.artifacts.map((record) => path.resolve(windowsDirectory, record.filename)))
  const publishableWindowsFiles = filesUnder(windowsDirectory).filter((filename) =>
    /\.(?:exe|msi|msix|zip)$/i.test(filename)
  )
  for (const filename of publishableWindowsFiles) {
    assert(recordedFiles.has(path.resolve(filename)), `Unrecorded Windows release asset is blocked: ${path.basename(filename)}`)
  }
  verifiedPlatforms.push("windows-x64-nsis-msi")
}

assert(verifiedPlatforms.includes("macos"), "Publication requires a complete verified Mac installer set.")
assert(verifiedPlatforms.includes("windows-x64-nsis-msi"), "Publication requires genuine Windows x64 NSIS and MSI installer sets from the same workflow.")
console.log(JSON.stringify({
  root,
  version,
  verifiedFiles: releaseFiles.length,
  verifiedPlatforms,
  checksumFile,
  verification: "genuine-installers-and-checksums-valid",
}, null, 2))
