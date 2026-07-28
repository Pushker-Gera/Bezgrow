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

async function verify() {
  const metadataResponse = await fetch(`${site}/api/desktop-release`, {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
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

  const download = await fetch(`${site}/api/downloads/desktop?platform=windows`, {
    method: "HEAD",
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(120_000),
  })
  const contentType = (download.headers.get("content-type") || "").toLowerCase()
  const disposition = download.headers.get("content-disposition") || ""
  if (download.status !== 200) {
    throw new Error(`Windows binary endpoint returned HTTP ${download.status}.`)
  }
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/json") ||
    contentType.startsWith("text/")
  ) {
    throw new Error(`Windows binary endpoint returned ${contentType || "an unknown content type"}.`)
  }
  if (!/attachment;\s*filename=/i.test(disposition)) {
    throw new Error("Windows binary endpoint did not return an attachment filename.")
  }

  console.log(
    `production-windows-download-ok version=${installer.version} bytes=${installer.size} sha256=${installer.sha256}`
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
