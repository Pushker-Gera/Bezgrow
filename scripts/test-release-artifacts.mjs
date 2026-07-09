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
