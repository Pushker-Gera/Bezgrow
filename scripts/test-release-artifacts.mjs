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
assert.match(desktopReleaseRoute, /@\/public\/downloads\/desktop-release\.json/, "Desktop release API must bundle the checked-in manifest.");
assert.doesNotMatch(desktopReleaseRoute, /node:fs|readFileSync|existsSync/, "Desktop release API must not depend on serverless filesystem reads.");

const desktopDownloadRoute = readFileSync("app/api/downloads/desktop/route.ts", "utf8");
const downloadPage = readFileSync("app/download/page.tsx", "utf8");
const appUpdates = readFileSync("lib/app-updates.ts", "utf8");
assert.doesNotMatch(desktopDownloadRoute, /github\.com\/Pushker-Gera\/Bezgrow|remoteRelease/, "Download API must not invent unverified remote installer URLs.");
assert.match(desktopDownloadRoute, /method:\s*"HEAD"/, "Download API must verify explicit remote installer URLs before redirecting.");
assert.match(desktopDownloadRoute, /@\/public\/downloads\/desktop-release\.json/, "Download API must bundle the checked-in desktop release manifest.");
assert.doesNotMatch(desktopDownloadRoute, /node:fs|readFileSync|existsSync|statSync/, "Download API must not depend on serverless filesystem reads.");
assert.match(desktopDownloadRoute, /href\.startsWith\("\/downloads\/"\)/, "Download API must only redirect local installer paths under /downloads.");
assert.doesNotMatch(downloadPage, /defaultWindowsRelease|githubReleaseBaseUrl/, "Download page must not mark missing Windows installers as available.");
assert.doesNotMatch(appUpdates, /fallbackWindowsRelease|github\.com\/Pushker-Gera\/Bezgrow/, "Update checks must not invent missing Windows installer URLs.");

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
