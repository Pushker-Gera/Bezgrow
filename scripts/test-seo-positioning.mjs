import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const layout = read("app/layout.tsx")
const home = read("app/page.tsx")
const homeClient = read("app/home-client.tsx")
const download = read("app/download/page.tsx")
const landing = read("app/(seo)/[slug]/page.tsx")
const pages = read("lib/seo-pages.ts")
const sitemap = read("app/sitemap.ts")
const robots = read("app/robots.ts")
const proxy = read("proxy.ts")
const manifest = read("public/manifest.json")
const publicPositioning = [layout, home, homeClient, download, landing, pages, manifest].join("\n")

assert.match(home, /Bezgrow \| Offline Billing & Inventory Software/)
assert.match(home, /Professional local-first billing, invoicing and inventory management software/)
assert.match(layout, /operatingSystem: "Windows, macOS"/)
assert.match(landing, /operatingSystem: "Windows, macOS"/)
assert.doesNotMatch(publicPositioning, /(?:is|as|one fast) (?:a )?cloud[- ]based|Cloud Inventory Management|Business Cloud|cloud ERP workspace/i)
assert.doesNotMatch(publicPositioning, /products, customers, invoices,? (?:and )?orders|customers, orders|invoices, orders/i)
assert.match(pages, /slug: "offline-inventory-software"/)
assert.doesNotMatch(pages, /slug: "cloud-inventory-management-software"/)

for (const route of ["/download", "/inventory", "/billing", "/pos", "/erp"]) {
  assert.match(sitemap, new RegExp(route.replace("/", "\\/")), `Public sitemap is missing ${route}`)
}
for (const route of ["/login", "/signup", "/reset-password", "/rejected"]) {
  assert.doesNotMatch(sitemap, new RegExp(`path: "${route.replace("/", "\\/")}"`), `Private/auth route ${route} must not be in the sitemap`)
}
for (const route of ["/admin", "/api", "/dashboard", "/offline", "/profile"]) {
  assert.match(robots, new RegExp(route.replaceAll("/", "\\/")), `robots.txt must protect ${route}`)
}
assert.match(proxy, /X-Robots-Tag": "noindex, nofollow, noarchive"/)
assert.doesNotMatch(`${layout}\n${home}\n${landing}`, /price: "0"/, "Structured data must not advertise an unverified free offer")

console.log("seo-positioning-ok title=offline-billing-inventory os=windows-macos sitemap=public-only private=noindex cloud-erp-claims=0")
