import { createHash } from "node:crypto"
import { basename } from "node:path"

const args = process.argv.slice(2)

function arg(name, fallback = "") {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || fallback : fallback
}

const site = arg("--site", "https://www.bezgrow.com").replace(/\/$/, "")
const expectedVersion = arg("--version")
const attempts = Math.max(1, Number(arg("--attempts", "1")) || 1)
const intervalMs = Math.max(0, Number(arg("--interval-ms", "0")) || 0)

if (!/^https:\/\//i.test(site)) throw new Error("Production site must use HTTPS.")
if (!expectedVersion) throw new Error("Expected Windows version is required.")

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dispositionFilename(value) {
  if (!value) return ""
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1]
  const raw = encoded || plain || ""
  try {
    return basename(decodeURIComponent(raw.trim()))
  } catch {
    return basename(raw.trim())
  }
}

function peArchitecture(bytes) {
  if (bytes.length < 64 || bytes.subarray(0, 2).toString("ascii") !== "MZ") return null
  const peOffset = bytes.readUInt32LE(0x3c)
  if (
    peOffset < 64 ||
    peOffset + 6 > bytes.length ||
    !bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
  ) {
    return null
  }
  const machine = bytes.readUInt16LE(peOffset + 4)
  if (machine === 0x14c) return "x86"
  if (machine === 0x8664) return "x86_64"
  if (machine === 0xaa64) return "arm64"
  return "unsupported"
}

async function verifyBinaryResponse(response, installer, label) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase()
  const disposition = response.headers.get("content-disposition") || ""
  if (response.status !== 200) {
    throw new Error(`${label} returned HTTP ${response.status}.`)
  }
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/json") ||
    contentType.startsWith("text/")
  ) {
    throw new Error(`${label} returned ${contentType || "an unknown content type"}.`)
  }
  if (!response.body) throw new Error(`${label} did not contain a readable response body.`)

  const actualFilename = dispositionFilename(disposition)
  if (!actualFilename) throw new Error(`${label} did not return an attachment filename.`)
  if (actualFilename !== installer.filename) {
    throw new Error(`${label} returned filename ${actualFilename} instead of ${installer.filename}.`)
  }

  const hash = createHash("sha256")
  let size = 0
  let firstBytes = Buffer.alloc(0)
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const bytes = Buffer.from(value)
    if (firstBytes.length < 4096) {
      firstBytes = Buffer.concat([firstBytes, bytes]).subarray(0, 4096)
    }
    hash.update(bytes)
    size += bytes.length
    if (size > 2 * 1024 * 1024 * 1024) {
      await reader.cancel()
      throw new Error(`${label} exceeded the 2 GB verification limit.`)
    }
  }

  const sha256 = hash.digest("hex")
  if (size !== installer.size) {
    throw new Error(`${label} size ${size} does not match metadata size ${installer.size}.`)
  }
  if (sha256 !== installer.sha256.toLowerCase()) {
    throw new Error(`${label} SHA-256 does not match production metadata.`)
  }
  const architecture = peArchitecture(firstBytes)
  const setupBootstrap = architecture === "x86" && /(?:^|-)setup(?:-|\.)/i.test(actualFilename)
  if (!architecture || architecture === "unsupported" || architecture === "arm64") {
    throw new Error(`${label} is not a valid Windows Intel/AMD PE executable.`)
  }
  if (architecture !== "x86_64" && !setupBootstrap) {
    throw new Error(`${label} PE architecture ${architecture} is not a valid x64 installer bootstrap.`)
  }

  return { size, sha256, filename: actualFilename, contentType, peArchitecture: architecture }
}

async function getBinary(url, installer, label) {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
    headers: {
      Accept: "application/octet-stream, application/vnd.microsoft.portable-executable",
    },
  })
  return verifyBinaryResponse(response, installer, label)
}

async function verify() {
  const metadataResponse = await fetch(`${site}/api/desktop-release`, {
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  })
  if (!metadataResponse.ok) {
    throw new Error(`Desktop release metadata returned HTTP ${metadataResponse.status}.`)
  }
  const payload = await metadataResponse.json()
  const windows = payload?.platforms?.windows || payload?.windows
  const installer = windows?.installer || windows
  if (windows?.available !== true || installer?.available === false) {
    throw new Error(windows?.blockedReason || windows?.reason || "Windows download is still disabled.")
  }
  if (installer?.version !== expectedVersion) {
    throw new Error(
      `Production reports Windows ${installer?.version || "unknown"} instead of ${expectedVersion}.`
    )
  }
  if (!/^[a-f0-9]{64}$/i.test(installer?.sha256 || "") || !(installer?.size > 1024 * 1024)) {
    throw new Error("Production Windows metadata is missing a credible size or SHA-256.")
  }
  if (!/^https:\/\//i.test(installer?.downloadUrl || "")) {
    throw new Error("Production Windows metadata does not use a permanent public HTTPS URL.")
  }
  if (!/github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(installer.downloadUrl)) {
    throw new Error("Production Windows installer is not stored at a durable GitHub Release URL.")
  }
  if (!/\.exe$/i.test(installer.filename || "")) {
    throw new Error("Production Windows metadata does not select the NSIS .exe installer.")
  }
  if (!["x64", "x86_64"].includes(installer.architecture)) {
    throw new Error(`Production Windows metadata reports unsupported architecture ${installer.architecture || "unknown"}.`)
  }

  const permanent = await getBinary(installer.downloadUrl, installer, "Permanent Windows release URL")
  const proxied = await getBinary(
    `${site}/api/downloads/desktop?platform=windows`,
    installer,
    "Production Windows download button endpoint"
  )

  console.log(
    `production-windows-download-ok version=${installer.version} architecture=${installer.architecture} filename=${installer.filename} bytes=${installer.size} sha256=${installer.sha256} signed=${installer.signed === true} permanent_pe=${permanent.peArchitecture} proxy_pe=${proxied.peArchitecture}`
  )
}

let lastError
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await verify()
    process.exit(0)
  } catch (error) {
    lastError = error
    console.log(
      `Production verification attempt ${attempt}/${attempts} is not ready: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    if (attempt < attempts) await wait(intervalMs)
  }
}

throw lastError
