import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { basename, extname, resolve } from "node:path"

const args = process.argv.slice(2)

function arg(name, fallback = "") {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || fallback : fallback
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const filePath = resolve(arg("--file"))
const platform = arg("--platform")
const architecture = arg("--architecture")
const version = arg("--version")
const expectedSha256 = arg("--sha256").toLowerCase()
const expectedSize = Number(arg("--size", "0"))

if (!existsSync(filePath)) fail(`Installer does not exist: ${filePath}`)
if (!["macos", "windows"].includes(platform)) fail("Platform must be macos or windows.")
if (architecture && !["arm64", "x64", "x86_64"].includes(architecture)) {
  fail("Architecture must be arm64, x64, or x86_64.")
}
const comparableArchitecture = architecture === "x86_64" ? "x64" : architecture

const details = statSync(filePath)
if (!details.isFile() || details.size <= 0) fail("Installer is empty or is not a file.")
const filename = basename(filePath)
const extension = extname(filename).toLowerCase()
if (platform === "macos" && extension !== ".dmg") fail("macOS installer must be a .dmg file.")
if (platform === "windows" && ![".exe", ".msi", ".msix"].includes(extension)) {
  fail("Windows installer must be an .exe, .msi, or .msix file.")
}

const handle = openSync(filePath, "r")
const firstBytes = Buffer.alloc(Math.min(4096, details.size))
const trailingBytes = Buffer.alloc(Math.min(512, details.size))
readSync(handle, firstBytes, 0, firstBytes.length, 0)
readSync(handle, trailingBytes, 0, trailingBytes.length, Math.max(0, details.size - trailingBytes.length))
closeSync(handle)

const textPrefix = firstBytes.toString("utf8").trimStart().toLowerCase()
if (
  textPrefix.startsWith("<!doctype html") ||
  textPrefix.startsWith("<html") ||
  textPrefix.startsWith("{") ||
  textPrefix.startsWith("[")
) {
  fail("Installer bytes are HTML, JSON, or text.")
}

function peArchitecture(bytes) {
  if (bytes.length < 64 || bytes.subarray(0, 2).toString("ascii") !== "MZ") return ""
  const peOffset = bytes.readUInt32LE(0x3c)
  if (
    peOffset < 64 ||
    peOffset + 6 > bytes.length ||
    bytes.subarray(peOffset, peOffset + 4).toString("binary") !== "PE\u0000\u0000"
  ) {
    return ""
  }
  const machine = bytes.readUInt16LE(peOffset + 4)
  if (machine === 0x14c) return "x86"
  if (machine === 0x8664) return "x64"
  if (machine === 0xaa64) return "arm64"
  return "unsupported"
}

const executableArchitecture = extension === ".exe" ? peArchitecture(firstBytes) : ""
const is32BitInstallerBootstrap =
  executableArchitecture === "x86" &&
  (filename.toLowerCase().includes("-setup") || filename.toLowerCase().includes("portable"))
const magicValid =
  extension === ".dmg"
    ? trailingBytes.includes(Buffer.from("koly"))
    : extension === ".exe"
      ? ["x86", "x64", "arm64"].includes(executableArchitecture)
      : extension === ".msi"
        ? firstBytes
            .subarray(0, 8)
            .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
        : firstBytes.subarray(0, 2).toString("ascii") === "PK"
if (!magicValid) fail("Installer file signature is invalid or the file is corrupted.")

const minimumSize =
  extension === ".dmg"
    ? 5 * 1024 * 1024
    : extension === ".exe" || extension === ".msi" || extension === ".msix"
      ? 1024 * 1024
      : 1
if (details.size < minimumSize) {
  fail(`Installer is implausibly small: expected at least ${minimumSize} bytes, found ${details.size}.`)
}

const sha256 = createHash("sha256").update(readFileSync(filePath)).digest("hex")
if (expectedSize > 0 && expectedSize !== details.size) {
  fail(`Installer size mismatch: expected ${expectedSize}, found ${details.size}.`)
}
if (expectedSha256 && expectedSha256 !== sha256) fail("Installer SHA-256 mismatch.")

const lowerName = filename.toLowerCase()
const filenameArchitecture = /(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(lowerName)
  ? "arm64"
  : /(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/.test(lowerName)
    ? "x64"
    : ""
if (architecture && filenameArchitecture && comparableArchitecture !== filenameArchitecture) {
  fail(`Installer architecture ${filenameArchitecture} does not match ${architecture}.`)
}
if (
  architecture &&
  executableArchitecture &&
  executableArchitecture !== "unsupported" &&
  !is32BitInstallerBootstrap &&
  comparableArchitecture !== executableArchitecture
) {
  fail(
    `Windows PE machine architecture ${executableArchitecture} does not match ${architecture}.`
  )
}
const filenameVersion =
  filename.match(/(?:^|[-_.])v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:[-_.]|$)/i)?.[1] || ""
if (version && filenameVersion && version !== filenameVersion) {
  fail(`Installer version ${filenameVersion} does not match ${version}.`)
}

console.log(
  JSON.stringify({
    file: filePath,
    filename,
    platform,
    architecture: architecture || filenameArchitecture || null,
    version: version || filenameVersion || null,
    size: details.size,
    sha256,
    valid: true,
  })
)
