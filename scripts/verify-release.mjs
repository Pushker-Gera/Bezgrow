import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1] || fallback
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: process.cwd(), encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed.`)
  return result.stdout.trim()
}

const positionalVersion = process.argv.slice(2).find((value) => /^\d+\.\d+\.\d+$/.test(value)) || ""
const version = arg("--version", positionalVersion)
const root = path.resolve(arg("--root", "release-artifacts"))
const commit = arg("--commit", execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim())
const mode = arg("--mode", "internal").toLowerCase()
const allowStaged = /^(1|true|yes)$/i.test(arg("--allow-staged", "false"))

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("A stable semantic release version is required.")
if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("The exact 40-character release commit is required.")
if (!["internal", "stable"].includes(mode)) throw new Error("--mode must be internal or stable.")

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version
if (version !== packageVersion) {
  throw new Error(`Requested candidate ${version} does not match authoritative source version ${packageVersion}.`)
}
if (!existsSync(root)) throw new Error(`Release artifact root is missing: ${root}`)

run(process.execPath, ["scripts/verify-release-version-alignment.mjs"])
const requiredPlatforms = allowStaged ? arg("--required-platforms", "macos") : "macos,windows"
const verification = run(process.execPath, [
  "scripts/verify-release-publication-inputs.mjs",
  "--root", root,
  "--checksums", path.join(root, "SHA256SUMS.txt"),
  "--version", version,
  "--commit", commit,
  "--required-platforms", requiredPlatforms,
])

if (mode === "stable") {
  if (requiredPlatforms.includes("macos")) {
    const macSigning = readFileSync(path.join(root, "mac", "mac-signing-status.txt"), "utf8").trim()
    const macNotarization = readFileSync(path.join(root, "mac", "mac-notarization-status.txt"), "utf8").trim()
    const macUpdater = readFileSync(path.join(root, "mac", "mac-updater-status.txt"), "utf8").trim()
    if (macSigning !== "true" || macNotarization !== "true" || macUpdater !== "true") {
      throw new Error("Stable publication requires signed, notarized, updater-signed macOS artifacts.")
    }
  }
  if (requiredPlatforms.includes("windows")) {
    const windowsSigning = readFileSync(path.join(root, "windows-x64", "windows-signing-status.txt"), "utf8").trim()
    const windowsUpdater = readFileSync(path.join(root, "windows-x64", "windows-updater-status.txt"), "utf8").trim()
    if (windowsSigning !== "valid" || windowsUpdater !== "true") {
      throw new Error("Stable publication requires trusted-signed and updater-signed Windows artifacts.")
    }
  }
}

console.log(JSON.stringify({
  candidateVersion: version,
  authoritativeSourceVersion: packageVersion,
  sourceCommit: commit,
  mode,
  requiredPlatforms: requiredPlatforms.split(","),
  validation: JSON.parse(verification),
  publishable: true,
}, null, 2))
