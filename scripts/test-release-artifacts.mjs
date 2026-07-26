import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const desktopManifestPath = "public/downloads/desktop-release.json";
assert.ok(existsSync(desktopManifestPath), "Desktop release manifest is missing.");

const manifest = readJson(desktopManifestPath);
assert.ok(manifest.version, "Desktop release manifest version is missing.");

const desktopReleaseRoute = readFileSync("app/api/desktop-release/route.ts", "utf8");
const publicReleaseSource = readFileSync("lib/releases/public.ts", "utf8");
const releaseWorkflow = readFileSync(".github/workflows/desktop-release.yml", "utf8");
const releaseManifestWriter = readFileSync("scripts/write-desktop-release-manifest.mjs", "utf8");
assert.match(desktopReleaseRoute, /@\/public\/downloads\/desktop-release\.json/, "Desktop release API must bundle the checked-in manifest.");
assert.doesNotMatch(desktopReleaseRoute, /node:fs|readFileSync|existsSync/, "Desktop release API must not depend on serverless filesystem reads.");
assert.match(desktopReleaseRoute, /getPublicDesktopReleaseManifest/, "Desktop update metadata must prefer validated control-plane releases.");
assert.match(publicReleaseSource, /\.eq\("release_status", "published"\)/, "Public updates must only include published releases.");
assert.match(publicReleaseSource, /\.eq\("active", true\)/, "Public updates must only include active releases.");
assert.match(publicReleaseSource, /\.eq\("rollout_percentage", 100\)/, "Unauthenticated public feeds must not bypass staged rollouts.");
assert.match(publicReleaseSource, /validation_status !== "valid"/, "Public updates must reject unvalidated artifacts.");

const desktopDownloadRoute = readFileSync("app/api/downloads/desktop/route.ts", "utf8");
const downloadPage = readFileSync("app/download/page.tsx", "utf8");
const appUpdates = readFileSync("lib/app-updates.ts", "utf8");
const nextConfig = readFileSync("next.config.ts", "utf8");
assert.doesNotMatch(desktopDownloadRoute, /github\.com\/Pushker-Gera\/Bezgrow|remoteRelease/, "Download API must not invent unverified remote installer URLs.");
assert.match(desktopDownloadRoute, /method:\s*"HEAD"/, "Download API must verify explicit remote installer URLs before redirecting.");
assert.doesNotMatch(desktopDownloadRoute, /node:fs|readFileSync|existsSync|statSync/, "Download API must not depend on serverless filesystem reads.");
assert.match(desktopDownloadRoute, /href\.startsWith\("\/downloads\/"\)/, "Download API must only redirect local installer paths under /downloads.");
assert.match(desktopDownloadRoute, /Location: location\.toString\(\)/, "Download API must return a plain redirect response for serverless compatibility.");
assert.doesNotMatch(nextConfig, /source:\s*"\/api\/downloads\/desktop"[\s\S]*destination:\s*"\/downloads\/Bezgrow-mac\.dmg"/, "Routing must not bypass release validation for Mac downloads.");
assert.match(desktopDownloadRoute, /release\.signed !== true/, "Download API must reject unsigned artifacts.");
assert.match(desktopDownloadRoute, /platform === "mac" && release\.notarized !== true/, "Download API must reject unnotarized Mac artifacts.");
assert.match(downloadPage, /Internal testing only/, "Unready release artifacts must be marked internal testing only.");
assert.match(appUpdates, /release\?\.signed === true/, "Desktop updates must reject unsigned artifacts.");
assert.match(appUpdates, /api\/devices\/checkin/, "Desktop update checks must report through the authenticated device endpoint when a local license is available.");
assert.doesNotMatch(downloadPage, /defaultWindowsRelease|githubReleaseBaseUrl/, "Download page must not mark missing Windows installers as available.");
assert.doesNotMatch(appUpdates, /fallbackWindowsRelease|github\.com\/Pushker-Gera\/Bezgrow/, "Update checks must not invent missing Windows installer URLs.");
assert.match(releaseWorkflow, /platform:[\s\S]*type:\s*choice/, "Desktop releases must support platform-specific dispatches.");
assert.match(releaseWorkflow, /inputs\.platform == 'all' \|\| inputs\.platform == 'windows'/, "Windows releases must run independently from macOS releases.");
assert.match(releaseManifestWriter, /mac\.signed = mac\.notarized === true/, "Notarized Mac artifacts must be recorded as signed.");

if (manifest.mac?.file) {
  const macPath = `public${manifest.mac.file}`;
  assert.ok(existsSync(macPath), "Mac installer listed in manifest is missing.");
  assert.equal(statSync(macPath).size, manifest.mac.size, "Mac installer size does not match manifest.");
  assert.equal(sha256(macPath), manifest.mac.sha256, "Mac installer SHA-256 does not match manifest.");
}

const macReleasePath = "public/downloads/Bezgrow-mac.dmg.release.json";
if (existsSync(macReleasePath)) {
  const macRelease = readJson(macReleasePath);
  const macPath = "public/downloads/Bezgrow-mac.dmg";
  assert.ok(existsSync(macPath), "Mac release metadata exists but DMG is missing.");
  assert.equal(statSync(macPath).size, macRelease.size, "Mac release metadata size does not match DMG.");
  assert.equal(sha256(macPath), macRelease.sha256, "Mac release metadata SHA-256 does not match DMG.");
}

console.log("release-artifacts-ok");
