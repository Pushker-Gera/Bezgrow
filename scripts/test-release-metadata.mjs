import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"

const manifest = JSON.parse(readFileSync("public/downloads/desktop-release.json", "utf8"))
assert.match(manifest.version, /^\d+\.\d+\.\d+/, "Release manifest version is invalid.")

for (const [key, installer] of Object.entries(manifest)) {
  if (!installer || typeof installer !== "object" || Array.isArray(installer)) continue
  if (!["mac", "macX64", "windows", "windowsMsi", "windowsMsix", "windowsArm64", "windowsArm64Msi", "windowsArm64Msix"].includes(key)) continue
  for (const field of [
    "version",
    "platform",
    "architecture",
    "downloadUrl",
    "filename",
    "size",
    "sha256",
    "available",
    "signed",
    "notarized",
    "checksumVerified",
    "metadataValid",
    "productionRecommended",
    "releaseChannel",
  ]) {
    assert.notEqual(installer[field], undefined, `${key}.${field} is missing.`)
  }
  assert.ok(["macos", "windows"].includes(installer.platform), `${key} platform is invalid.`)
  assert.ok(["arm64", "x64", "x86_64"].includes(installer.architecture), `${key} architecture is invalid.`)
  assert.match(installer.sha256, /^[a-f0-9]{64}$/i, `${key} SHA-256 is invalid.`)
  assert.ok(installer.size > 0, `${key} size must be non-zero.`)
  if (installer.file?.startsWith("/downloads/")) {
    const path = `public${installer.file}`
    assert.ok(existsSync(path), `${key} local installer is missing.`)
    assert.equal(statSync(path).size, installer.size, `${key} local size mismatch.`)
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      installer.sha256,
      `${key} local checksum mismatch.`
    )
  }
  if (!installer.signed || (installer.platform === "macos" && !installer.notarized)) {
    assert.equal(installer.releaseChannel, "internal", `${key} unsigned build must be internal/testing.`)
    assert.equal(installer.productionRecommended, false, `${key} unsigned build must not be production-recommended.`)
    assert.match(installer.warning, /Internal\/testing build:/, `${key} trust warning is missing.`)
  }
}

console.log("release-metadata-ok")
