import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(path, "utf8")
const route = read("app/api/downloads/desktop/route.ts")
const releaseApi = read("app/api/desktop-release/route.ts")
const page = read("app/download/page.tsx")
const validator = read("lib/releases/artifact-validation.ts")

assert.match(releaseApi, /platforms:[\s\S]*macos:[\s\S]*windows:/, "Release API must expose both platforms independently.")
assert.match(route, /release\.available/, "Download route must require integrity availability.")
assert.match(route, /release\.blockedReason/, "Disabled routes must return an exact blocked reason.")
assert.match(route, /binaryInstallerResponse/, "Validated installers must be returned as binary responses.")
assert.match(route, /status:\s*200/, "The download endpoint must return HTTP 200 for genuine installer bytes.")
assert.match(route, /Content-Disposition/, "The download endpoint must set an explicit installer filename.")
assert.match(route, /Content-Type/, "The download endpoint must set a binary installer content type.")
assert.doesNotMatch(route, /signed\s*!==\s*true|notarized\s*!==\s*true/, "Trust status must not disable downloads.")
assert.match(page, /<DownloadButton href=\{downloadHref\} available=\{info\.available\}>/, "Button state must follow availability.")
assert.match(page, /disabled/, "Unavailable platforms must render a disabled button.")
assert.match(page, /info\.warning/, "Available internal/testing builds must show a warning.")
assert.match(page, /info\.blockedReason/, "Unavailable platforms must show the exact reason.")
assert.match(validator, /Installer URL returned HTML, JSON, or text/, "HTML download responses must be rejected.")
assert.match(validator, /Installer file signature is invalid/, "Corrupt installers must be rejected.")
assert.match(validator, /Installer SHA-256 does not match/, "Checksum mismatches must be rejected.")

console.log("download-routes-ok")
