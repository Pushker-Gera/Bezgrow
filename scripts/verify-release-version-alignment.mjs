import { readFileSync } from "node:fs"

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"))
}

function cargoPackageVersion(filename, packageName) {
  const source = readFileSync(filename, "utf8")
  const packageBlock = source.match(
    new RegExp(`(?:^|\\r?\\n)\\[\\[package\\]\\]\\r?\\nname = "${packageName}"\\r?\\nversion = "([^"]+)"`)
  )
  if (!packageBlock) throw new Error(`Cargo.lock is missing ${packageName}.`)
  return packageBlock[1]
}

function cargoManifestVersion(filename) {
  const source = readFileSync(filename, "utf8")
  const packageSection = source.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] || ""
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (!version) throw new Error("src-tauri/Cargo.toml is missing package.version.")
  return version
}

const packageJson = readJson("package.json")
const packageLock = readJson("package-lock.json")
const tauriConfig = readJson("src-tauri/tauri.conf.json")
const releaseNotes = readFileSync("RELEASE_NOTES.md", "utf8")
const publishedManifest = readJson("public/downloads/desktop-release.json")
const expectedVersion = packageJson.version
const applicationVersions = {
  "package.json": expectedVersion,
  "package-lock.json": packageLock.packages?.[""]?.version,
  "src-tauri/tauri.conf.json": tauriConfig.version,
  "src-tauri/Cargo.toml": cargoManifestVersion("src-tauri/Cargo.toml"),
  "src-tauri/Cargo.lock": cargoPackageVersion("src-tauri/Cargo.lock", "bezgrow-erp"),
}

if (!/^\d+\.\d+\.\d+$/.test(expectedVersion || "")) {
  throw new Error(`Release version ${expectedVersion || "(missing)"} is not a stable semantic version.`)
}
for (const [filename, version] of Object.entries(applicationVersions)) {
  if (version !== expectedVersion) {
    throw new Error(`${filename} reports ${version || "(missing)"}; expected ${expectedVersion}.`)
  }
}

const releaseNotesVersion = releaseNotes.match(/^# Bezgrow (\d+\.\d+\.\d+)\s*$/m)?.[1]
if (releaseNotesVersion !== expectedVersion) {
  throw new Error(`RELEASE_NOTES.md reports ${releaseNotesVersion || "(missing)"}; expected source version ${expectedVersion}.`)
}

if (publishedManifest.publicationStatus !== "published") {
  throw new Error("public/downloads/desktop-release.json must describe an explicitly published fallback release.")
}
const publicInstallerKeys = ["mac", "macX64", "windows", "windowsMsi", "windowsMsix", "windowsArm64", "windowsArm64Msi", "windowsArm64Msix"]
for (const key of publicInstallerKeys) {
  const installer = publishedManifest[key]
  if (!installer) continue
  if (installer.version !== publishedManifest.version) {
    throw new Error(`Published ${key} metadata reports ${installer.version || "(missing)"}; expected public release ${publishedManifest.version}.`)
  }
  if (installer.publicationStatus !== "published") {
    throw new Error(`Published ${key} metadata is not explicitly marked published.`)
  }
}

const tauriVersions = {
  cli: packageLock.packages?.["node_modules/@tauri-apps/cli"]?.version,
  api: packageLock.packages?.["node_modules/@tauri-apps/api"]?.version,
  rust: cargoPackageVersion("src-tauri/Cargo.lock", "tauri"),
  updater: cargoPackageVersion("src-tauri/Cargo.lock", "tauri-plugin-updater"),
}
if (!tauriVersions.cli || !tauriVersions.rust || tauriVersions.cli !== tauriVersions.rust) {
  throw new Error(
    `Tauri CLI ${tauriVersions.cli || "(missing)"} and Rust crate ${tauriVersions.rust || "(missing)"} must match.`
  )
}

console.log(JSON.stringify({
  releaseVersion: expectedVersion,
  applicationVersions,
  releaseNotesVersion,
  latestPublishedVersion: publishedManifest.version,
  sourceAndPublicVersionsAreIndependent: true,
  tauriVersions,
}, null, 2))
