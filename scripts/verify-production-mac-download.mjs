import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { spawn, spawnSync } from "node:child_process"

const args = process.argv.slice(2)

function arg(name, fallback = "") {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || fallback : fallback
}

const site = arg("--site", "https://www.bezgrow.com").replace(/\/$/, "")
const expectedVersion = arg("--version")
const expectedCommit = arg("--commit")
const attempts = Math.max(1, Number(arg("--attempts", "1")) || 1)
const intervalMs = Math.max(0, Number(arg("--interval-ms", "0")) || 0)
const launch = /^(1|true|yes)$/i.test(arg("--launch"))

if (!/^https:\/\//i.test(site)) throw new Error("Production site must use HTTPS.")
if (!expectedVersion) throw new Error("Expected Mac version is required.")
if (expectedCommit && !/^[a-f0-9]{40}$/i.test(expectedCommit)) {
  throw new Error("Expected Mac commit must be a complete 40-character SHA.")
}

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

function jsFilesUnder(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filename = join(root, entry.name)
    if (entry.isDirectory()) files.push(...jsFilesUnder(filename))
    else if (entry.name.endsWith(".js")) files.push(filename)
  }
  return files
}

async function download(url, installer, label, outputPath) {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(300_000),
    headers: { Accept: "application/octet-stream, application/x-apple-diskimage" },
  })
  if (response.status !== 200) throw new Error(`${label} returned HTTP ${response.status}.`)
  const contentType = (response.headers.get("content-type") || "").toLowerCase()
  if (
    label.includes("button")
      ? !contentType.includes("application/x-apple-diskimage")
      : !/(application\/x-apple-diskimage|application\/octet-stream)/i.test(contentType)
  ) {
    throw new Error(`${label} returned ${contentType || "an unknown content type"}.`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (bytes.length !== installer.size) {
    throw new Error(`${label} size ${bytes.length} does not match ${installer.size}.`)
  }
  if (sha256 !== installer.sha256.toLowerCase()) {
    throw new Error(`${label} SHA-256 does not match production metadata.`)
  }
  if (!bytes.subarray(Math.max(0, bytes.length - 512)).includes(Buffer.from("koly"))) {
    throw new Error(`${label} does not have a valid DMG trailer.`)
  }
  const filename = dispositionFilename(response.headers.get("content-disposition"))
  if (label.includes("button") && filename !== installer.filename) {
    throw new Error(`${label} returned filename ${filename || "(missing)"} instead of ${installer.filename}.`)
  }
  writeFileSync(outputPath, bytes)
  return {
    size: bytes.length,
    sha256,
    filename: filename || basename(new URL(response.url).pathname),
    contentType,
    cacheControl: response.headers.get("cache-control") || "",
  }
}

async function inspectMountedDmg(dmgPath, installer, temporaryRoot) {
  if (process.platform !== "darwin") {
    throw new Error("Mounted production-DMG verification must run on macOS.")
  }
  const mountPoint = join(temporaryRoot, "mounted")
  const attach = spawnSync(
    "hdiutil",
    ["attach", "-quiet", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath],
    { encoding: "utf8" }
  )
  if (attach.status !== 0) throw new Error(attach.stderr || "Production DMG could not be mounted.")
  try {
    const app = join(mountPoint, "Bezgrow.app")
    const plist = join(app, "Contents", "Info.plist")
    const version = spawnSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleShortVersionString", plist],
      { encoding: "utf8" }
    ).stdout.trim()
    if (version !== expectedVersion) {
      throw new Error(`Mounted production app reports ${version} instead of ${expectedVersion}.`)
    }

    const identityPath = join(app, "Contents", "Resources", "next-server", "public", "desktop-build.json")
    const identity = JSON.parse(readFileSync(identityPath, "utf8"))
    if (identity.applicationVersion !== expectedVersion) {
      throw new Error("Mounted production app build identity has the wrong version.")
    }
    if (!/^[a-f0-9]{40}$/i.test(identity.gitCommit || "")) {
      throw new Error("Mounted production app build identity has no full Git commit.")
    }
    if (expectedCommit && identity.gitCommit !== expectedCommit) {
      throw new Error(`Mounted production app came from ${identity.gitCommit}, not ${expectedCommit}.`)
    }
    if (Number.isNaN(Date.parse(identity.builtAt))) {
      throw new Error("Mounted production app build identity has no valid timestamp.")
    }
    if (identity.sourceTreeDirty !== false) {
      throw new Error("Mounted production app was built from a dirty source tree.")
    }

    const serverRoot = join(app, "Contents", "Resources", "next-server", ".next")
    const packagedJavaScript = jsFilesUnder(serverRoot).map((filename) => readFileSync(filename, "utf8"))
    if (packagedJavaScript.some((source) => source.includes("Create secure share link"))) {
      throw new Error("Mounted production app still contains the obsolete secure-share modal.")
    }
    if (!packagedJavaScript.some((source) => source.includes("The exact previewed invoice PDF remains on this device"))) {
      throw new Error("Mounted production app is missing the local-first WhatsApp/PDF marker.")
    }
    if (!packagedJavaScript.some((source) => source.includes("canonical-pdf-preview"))) {
      throw new Error("Mounted production app is missing the canonical PDF preview implementation.")
    }
    const executable = join(app, "Contents", "MacOS", "Bezgrow")
    if (!readFileSync(executable).includes(Buffer.from("desktop_open_pdf_for_print"))) {
      throw new Error("Mounted production app is missing the validated native PDF print command.")
    }

    if (launch) {
      const child = spawn(executable, [], { stdio: "ignore" })
      await wait(8_000)
      if (child.exitCode !== null) {
        throw new Error(`Mounted production app exited during launch verification (${child.exitCode}).`)
      }
      child.kill("SIGTERM")
      await wait(1_000)
    }

    return {
      bundleVersion: version,
      gitCommit: identity.gitCommit,
      builtAt: identity.builtAt,
      applicationBytes: statSync(executable).size,
      whatsapp: "local-first",
      pdf: "canonical",
      print: "desktop_open_pdf_for_print",
      launched: launch,
      artifactFilename: installer.filename,
    }
  } finally {
    spawnSync("hdiutil", ["detach", "-quiet", mountPoint], { encoding: "utf8" })
  }
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
  const mac = payload?.platforms?.macos || payload?.mac
  const installer = mac?.installer || mac
  if (mac?.available !== true || installer?.available === false) {
    throw new Error(mac?.blockedReason || mac?.reason || "Mac download is still disabled.")
  }
  if (installer?.version !== expectedVersion) {
    throw new Error(`Production reports Mac ${installer?.version || "unknown"} instead of ${expectedVersion}.`)
  }
  if (!/^[a-f0-9]{64}$/i.test(installer?.sha256 || "") || !(installer?.size > 5 * 1024 * 1024)) {
    throw new Error("Production Mac metadata is missing a credible size or SHA-256.")
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(installer?.downloadUrl || "")) {
    throw new Error("Production Mac installer is not stored at a durable GitHub Release URL.")
  }
  if (installer.filename !== `Bezgrow-${expectedVersion}-${installer.architecture}.dmg`) {
    throw new Error("Production Mac metadata does not use the versioned immutable filename.")
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "bezgrow-production-mac-"))
  try {
    const permanentPath = join(temporaryRoot, "permanent.dmg")
    const productionPath = join(temporaryRoot, installer.filename)
    const permanent = await download(installer.downloadUrl, installer, "Permanent Mac release URL", permanentPath)
    const proxied = await download(
      `${site}/api/downloads/desktop?platform=mac`,
      installer,
      "Production Mac download button endpoint",
      productionPath
    )
    if (!/no-store/i.test(proxied.cacheControl)) {
      throw new Error("Production Mac download endpoint is missing no-store cache protection.")
    }
    const legacy = await fetch(`${site}/downloads/Bezgrow-mac.dmg`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    })
    if (legacy.status !== 307 || !legacy.headers.get("location")?.includes(installer.filename)) {
      throw new Error("Legacy generic Mac URL does not redirect to the current versioned artifact.")
    }
    const mounted = await inspectMountedDmg(productionPath, installer, temporaryRoot)
    console.log(JSON.stringify({
      verification: "production-mac-download-ok",
      publicUrl: `${site}/api/downloads/desktop?platform=mac`,
      sourceUrl: installer.downloadUrl,
      version: installer.version,
      architecture: installer.architecture,
      filename: installer.filename,
      bytes: installer.size,
      sha256: installer.sha256,
      permanent,
      proxied,
      mounted,
    }, null, 2))
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

let lastError
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    await verify()
    process.exit(0)
  } catch (error) {
    lastError = error
    console.log(
      `Production Mac verification attempt ${attempt}/${attempts} is not ready: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    if (attempt < attempts) await wait(intervalMs)
  }
}

throw lastError
