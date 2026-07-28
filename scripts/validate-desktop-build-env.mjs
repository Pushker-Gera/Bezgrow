import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function fail(message) {
  throw new Error(message)
}

function required(name) {
  const value = (process.env[name] || "").trim()
  if (!value) fail(`Required desktop build variable ${name} is missing.`)
  return value
}

function httpsOrigin(name, value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${name} must be a valid absolute URL.`)
  }
  if (parsed.protocol !== "https:") fail(`${name} must use HTTPS.`)
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail(`${name} must be a clean HTTPS origin without credentials, query parameters, or fragments.`)
  }
  return parsed.origin
}

const publicValues = {
  NEXT_PUBLIC_SUPABASE_URL: required("NEXT_PUBLIC_SUPABASE_URL"),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  NEXT_PUBLIC_SITE_URL: required("NEXT_PUBLIC_SITE_URL"),
  NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY: required(
    "NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY"
  ),
}

httpsOrigin("NEXT_PUBLIC_SUPABASE_URL", publicValues.NEXT_PUBLIC_SUPABASE_URL)
httpsOrigin("NEXT_PUBLIC_SITE_URL", publicValues.NEXT_PUBLIC_SITE_URL)
if (process.env.NEXT_PUBLIC_DESKTOP_API_ORIGIN) {
  httpsOrigin(
    "NEXT_PUBLIC_DESKTOP_API_ORIGIN",
    process.env.NEXT_PUBLIC_DESKTOP_API_ORIGIN
  )
}
if (process.env.NEXT_PUBLIC_ADMIN_APP_URL) {
  httpsOrigin("NEXT_PUBLIC_ADMIN_APP_URL", process.env.NEXT_PUBLIC_ADMIN_APP_URL)
}

if (publicValues.NEXT_PUBLIC_SUPABASE_ANON_KEY.length < 40) {
  fail("NEXT_PUBLIC_SUPABASE_ANON_KEY is not a plausible Supabase public anon key.")
}
if (!/^[A-Za-z0-9_-]{32,}$/.test(publicValues.NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY)) {
  fail(
    "NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY must be a raw base64url public verification key."
  )
}

for (const forbiddenName of [
  "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_BEZGROW_LICENSE_PRIVATE_KEY",
  "NEXT_PUBLIC_WINDOWS_CERTIFICATE_BASE64",
  "NEXT_PUBLIC_WINDOWS_CERTIFICATE_PASSWORD",
]) {
  if ((process.env[forbiddenName] || "").trim()) {
    fail(
      `${forbiddenName} must not be present in the desktop web-build environment.`
    )
  }
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const tauriConfig = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")
)
const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8")
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
for (const [source, version] of [
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoVersion],
]) {
  if (version !== packageJson.version) {
    fail(
      `Desktop version mismatch: package.json is ${packageJson.version}, but ${source} is ${version || "missing"}.`
    )
  }
}

for (const path of [
  join(root, "src-tauri", "icons", "icon.ico"),
  join(root, "desktop-runtime", "next-server", ".gitkeep"),
  join(root, "desktop-runtime", "node", ".gitkeep"),
]) {
  if (!existsSync(path)) fail(`Required desktop build input is missing: ${path}`)
}

console.log(
  `desktop-build-env-ok version=${packageJson.version} public_variables=${Object.keys(publicValues).length}`
)
