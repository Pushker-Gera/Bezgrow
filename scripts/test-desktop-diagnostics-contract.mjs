import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const panel = read("components/settings/DesktopDiagnosticsPanel.tsx")
const settings = read("app/dashboard/settings/page.tsx")
const exportApi = read("lib/desktop-file-export.ts")
const rust = read("src-tauri/src/lib.rs")
const health = read("app/api/desktop-health/route.ts")
const prepare = read("scripts/prepare-desktop-build.mjs")

assert.match(settings, /DesktopDiagnosticsPanel/, "Desktop diagnostics must be available from Settings.")
assert.match(panel, /database[\s\S]*integrityStatus[\s\S]*startupStages/, "Diagnostics must report SQLite health and startup state.")
assert.match(panel, /license[\s\S]*expiresAt[\s\S]*graceDays/, "Diagnostics must include only a redacted license summary.")
assert.match(panel, /NEXT_PUBLIC_BEZGROW_BUILD_COMMIT/, "Diagnostics must expose the artifact's Git commit identity.")
assert.match(panel, /NEXT_PUBLIC_BEZGROW_BUILD_TIMESTAMP/, "Diagnostics must expose the artifact's build timestamp.")
assert.match(panel, /NEXT_PUBLIC_BEZGROW_BUILD_PLATFORM/, "Diagnostics must expose the build platform.")
assert.match(panel, /NEXT_PUBLIC_BEZGROW_BUILD_ARCHITECTURE/, "Diagnostics must expose the build architecture.")
assert.match(panel, /Bezgrow \{buildVersion\}/, "Settings must display the application version.")
assert.match(panel, /About \/ Version/, "Settings must expose an explicit About / Version section.")
assert.match(panel, /Copy Build ID/, "Settings must offer a safe build-identity copy action.")
assert.match(panel, /Build SHA: \$\{buildCommit\}/, "Copied build identity must contain the exact commit SHA.")
assert.match(panel, /Build date: \$\{buildTimestamp\}/, "Copied build identity must contain the exact build timestamp.")
assert.match(health, /desktop-build\.json[\s\S]*gitCommit[\s\S]*buildTimestamp[\s\S]*platform[\s\S]*architecture/, "Authenticated desktop health must expose the same safe build identity.")
assert.match(health, /build\.gitCommit !== nativeBuildCommit[\s\S]*build\.builtAt !== nativeBuildTimestamp/, "Desktop health must reject a web bundle whose identity differs from the native binary.")
assert.match(prepare, /platform:\s*buildPlatform[\s\S]*architecture:\s*targetArchitecture/, "The embedded build manifest must record platform and architecture.")
for (const forbidden of ["license_key", "device_id", "SUPABASE_SERVICE_ROLE_KEY", "BEZGROW_LICENSE_PRIVATE_KEY"]) {
  assert.doesNotMatch(panel, new RegExp(forbidden), `Diagnostic export must not include ${forbidden}.`)
}
assert.match(panel, /customers, products, invoices/, "The diagnostic privacy promise must name excluded business data.")
assert.match(exportApi, /"csv" \| "pdf" \| "json"/, "The shared save API must support JSON diagnostics.")
assert.ok(rust.includes('"json" => ("JSON diagnostics"'), "The native Save dialog must support JSON diagnostics.")
assert.match(rust, /from_slice::<serde_json::Value>/, "Native diagnostics must reject invalid JSON.")

console.log("desktop-diagnostics-contract-ok")
