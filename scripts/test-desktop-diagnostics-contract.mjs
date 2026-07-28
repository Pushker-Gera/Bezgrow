import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const panel = read("components/settings/DesktopDiagnosticsPanel.tsx")
const settings = read("app/dashboard/settings/page.tsx")
const exportApi = read("lib/desktop-file-export.ts")
const rust = read("src-tauri/src/lib.rs")

assert.match(settings, /DesktopDiagnosticsPanel/, "Desktop diagnostics must be available from Settings.")
assert.match(panel, /database[\s\S]*integrityStatus[\s\S]*startupStages/, "Diagnostics must report SQLite health and startup state.")
assert.match(panel, /license[\s\S]*expiresAt[\s\S]*graceDays/, "Diagnostics must include only a redacted license summary.")
for (const forbidden of ["license_key", "device_id", "SUPABASE_SERVICE_ROLE_KEY", "BEZGROW_LICENSE_PRIVATE_KEY"]) {
  assert.doesNotMatch(panel, new RegExp(forbidden), `Diagnostic export must not include ${forbidden}.`)
}
assert.match(panel, /customers, products, invoices/, "The diagnostic privacy promise must name excluded business data.")
assert.match(exportApi, /"csv" \| "pdf" \| "json"/, "The shared save API must support JSON diagnostics.")
assert.ok(rust.includes('"json" => ("JSON diagnostics"'), "The native Save dialog must support JSON diagnostics.")
assert.match(rust, /from_slice::<serde_json::Value>/, "Native diagnostics must reject invalid JSON.")

console.log("desktop-diagnostics-contract-ok")
