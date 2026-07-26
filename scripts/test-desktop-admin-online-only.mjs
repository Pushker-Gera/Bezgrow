import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const rust = read("src-tauri/src/lib.rs")
const launcher = read("components/desktop/PlatformAdminLauncher.tsx")
const adminLayout = read("app/admin/layout.tsx")
const proxy = read("proxy.ts")
const desktopProxy = read("app/api/desktop-proxy/route.ts")
const serviceWorker = read("public/sw.js")
const capability = read("src-tauri/capabilities/default.json")

assert.match(rust, /fn open_platform_admin/, "Desktop must expose a dedicated Platform Admin window.")
assert.match(rust, /validate_platform_admin_url/, "The native shell must validate the hosted admin URL.")
assert.match(rust, /bezgrow\.com" \| "www\.bezgrow\.com/, "Production admin windows must be restricted to Bezgrow.")
assert.match(rust, /WebviewUrl::External\(parsed\)/, "Desktop administration must load the hosted online application.")
assert.match(rust, /window\.label\(\) == "platform-admin"[\s\S]*return;/, "Closing admin must leave the local ERP running.")
assert.match(capability, /allow-open-platform-admin/, "The local ERP window needs only the narrow admin-window command.")

assert.match(launcher, /navigator\.onLine/, "Desktop admin launch must reject offline use.")
assert.match(launcher, /Internet connection required for Platform Administration/, "Offline rejection must be actionable.")
assert.match(launcher, /NEXT_PUBLIC_ADMIN_APP_URL/, "Desktop must use a configurable hosted admin origin.")
assert.match(adminLayout, /Internet connection required for Platform Administration/, "An open admin window must stop when connectivity is lost.")
assert.match(adminLayout, /local SQLite data are unchanged/, "Admin disconnects must preserve the local ERP workspace.")
assert.match(adminLayout, /Return to local ERP/, "Desktop admin must provide a return action.")

assert.match(proxy, /localDesktopHost && adminRoute[\s\S]*"\/platform-admin"/, "Local desktop admin routes must redirect to the hosted launcher.")
assert.match(desktopProxy, /apiPath\.startsWith\("\/api\/admin"\)/, "The bundled desktop proxy must not execute admin APIs.")
assert.match(serviceWorker, /requestUrl\.pathname\.startsWith\("\/admin"\)[\s\S]*cache:\s*"no-store"/, "Admin navigations must never use an offline cache.")
assert.match(serviceWorker, /adminOfflineResponse/, "Offline admin navigation must fail closed with a clear response.")

console.log("desktop-admin-online-only-contract-ok")
