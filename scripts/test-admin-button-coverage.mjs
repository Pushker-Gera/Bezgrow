import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const pages = {
  dashboard: read("app/admin/page.tsx"),
  licenses: read("app/admin/licenses/page.tsx"),
  devices: read("app/admin/devices/page.tsx"),
  customers: read("app/admin/customers/page.tsx"),
  businesses: read("app/admin/businesses/page.tsx"),
  releases: read("app/admin/releases/page.tsx"),
  backups: read("app/admin/backups/page.tsx"),
  support: read("app/admin/support/page.tsx"),
  security: read("app/admin/security/page.tsx"),
  analytics: read("app/admin/analytics/page.tsx"),
  download: read("app/download/page.tsx"),
}
const controls = read("components/admin/ControlPlaneUi.tsx")
const routes = {
  dashboard: read("app/api/admin/dashboard/route.ts"),
  licenses: read("app/api/admin/licenses/route.ts"),
  devices: read("app/api/admin/devices/route.ts"),
  customers: read("app/api/admin/customers/route.ts"),
  businesses: read("app/api/admin/businesses/route.ts"),
  releases: read("app/api/admin/releases/route.ts"),
  backups: read("app/api/admin/backups/route.ts"),
  support: read("app/api/admin/support/route.ts"),
  security: read("app/api/admin/audit-logs/route.ts"),
  analytics: read("app/api/admin/analytics/route.ts"),
}

for (const [name, source] of Object.entries(routes)) {
  assert.match(source, /csvResponse\(/, `${name} Export CSV must have a server CSV implementation.`)
}
assert.match(controls, /exportHref[\s\S]*Export CSV/, "List exports must render a real link.")
assert.match(controls, /setLoading\(true\)/, "Admin lists must display a loading state.")
assert.match(controls, /throw new Error\(payload\.error/, "Admin mutations must display actionable failures.")
assert.match(controls, /credentials:\s*"include"/, "Admin actions must send the authenticated session.")

assert.match(pages.dashboard, /AdminExportLink[\s\S]*format=csv/, "Dashboard Export CSV must be linked.")
assert.match(pages.dashboard, /Dashboard date range[\s\S]*setDays/, "Dashboard date range must be interactive.")
assert.match(pages.licenses, /onClick=\{\(\) =>[\s\S]*setCreateOpen\(true\)/, "Generate License must open its form.")
assert.match(pages.licenses, /Generate signed license/, "Generate License form must submit a real mutation.")
assert.match(pages.devices, /runAction|action\(row/, "Device row actions must call the device API.")
assert.match(pages.releases, /setCreateOpen\(true\)/, "Create Draft Release must open a form.")
assert.match(pages.releases, /adminMutation\("\/api\/admin\/releases", "POST"/, "Release form must create a draft.")
assert.match(pages.support, /setCreateOpen\(true\)/, "Create Support Case must open a form.")
assert.match(pages.support, /adminMutation\("\/api\/admin\/support", "POST"/, "Support form must save a case.")
assert.match(pages.security, /AdminListControls/, "Security search and filters must use live list controls.")
assert.match(pages.analytics, /onChange=\{\(event\) => setDays/, "Analytics range selector must trigger a reload.")
assert.match(pages.download, /available=\{info\.available\}/, "Download buttons must reflect independent availability.")
assert.match(pages.download, /href=\{webAppUrl\}/, "Open Web App must be a real link.")
assert.match(pages.download, /<span[\s\S]*cursor-not-allowed/, "Disabled downloads must not render enabled links.")
assert.doesNotMatch(pages.download, /checkedInReleaseManifest/, "Download buttons must not use stale checked-in metadata.")

for (const [name, source] of Object.entries(pages)) {
  assert.doesNotMatch(source, /<button(?![^>]*(?:onClick|type="submit"))[^>]*>/, `${name} contains a button without a handler or submit behavior.`)
}

console.log("admin-button-coverage-ok buttons=16")
