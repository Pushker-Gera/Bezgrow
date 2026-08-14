import { readFileSync } from "node:fs"

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"))
}

function cargoPackageVersion(filename, packageName) {
  const source = readFileSync(filename, "utf8")
  const packageBlock = source.match(
    new RegExp(`(?:^|\\n)\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = "([^"]+)"`)
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
  tauriVersions,
}, null, 2))
