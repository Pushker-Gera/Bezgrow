import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SAFE_AUTO_UPDATE_DELAY_MS,
  autoUpdateDue,
  clearPendingUpdateRestart,
  markUpdatePendingRestart,
  pendingUpdateHasLaunched,
  readPendingUpdateRestart,
  readUpdateDecision,
  remindLater,
  scheduleUpdate,
} from "../lib/desktop/update-state"
import { compareVersions, releaseForPlatform, type DesktopReleaseManifest } from "../lib/app-updates"
import { verifyUpdaterArtifact } from "../lib/releases/updater-signature"

const storage = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
})
Object.defineProperty(globalThis, "window", { value: { dispatchEvent: () => true } })
Object.defineProperty(globalThis, "CustomEvent", { value: class CustomEvent { constructor(public type: string, public init: unknown) {} } })

const firstSeen = Date.UTC(2026, 7, 1, 0, 0, 0)
const decision = readUpdateDecision("0.1.8", firstSeen)
assert.equal(autoUpdateDue(decision, firstSeen + SAFE_AUTO_UPDATE_DELAY_MS - 1), false)
assert.equal(autoUpdateDue(decision, firstSeen + SAFE_AUTO_UPDATE_DELAY_MS), true)
const reminded = remindLater("0.1.8", firstSeen)
assert.ok(reminded.nextPromptAt > firstSeen)
assert.equal(reminded.firstSeenAt, firstSeen)
const scheduled = scheduleUpdate("0.1.8", firstSeen + 60_000)
assert.equal(autoUpdateDue(scheduled, firstSeen + 60_000), true)
assert.equal(compareVersions("0.1.14", "0.1.13"), 1)
assert.equal(compareVersions("0.1.15", "0.1.14"), 1)
assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1)

const platformManifest: DesktopReleaseManifest = {
  version: "0.1.14",
  mac: { version: "0.1.14", signed: true, notarized: true, platform: "macos", architecture: "arm64" },
  macX64: { version: "0.1.14", signed: true, notarized: true, platform: "macos", architecture: "x86_64" },
  windows: { version: "0.1.14", signed: true, platform: "windows", architecture: "x86_64" },
  windowsArm64: { version: "0.1.14", signed: true, platform: "windows", architecture: "arm64" },
}
assert.equal(releaseForPlatform(platformManifest, "mac", "arm64"), platformManifest.mac)
assert.equal(releaseForPlatform(platformManifest, "mac", "x64"), platformManifest.macX64)
assert.equal(releaseForPlatform(platformManifest, "windows", "arm64"), platformManifest.windowsArm64)
assert.equal(releaseForPlatform({ windows: platformManifest.windows }, "windows", "arm64"), null, "Windows arm64 must never fall back to x64")
assert.equal(releaseForPlatform({ mac: platformManifest.mac }, "mac", "x64"), null, "Intel macOS must never receive arm64")

const pendingRestart = markUpdatePendingRestart("0.1.15", "0.1.14", firstSeen)
assert.deepEqual(readPendingUpdateRestart(), pendingRestart)
assert.equal(pendingUpdateHasLaunched(pendingRestart, "0.1.14"), false)
assert.equal(pendingUpdateHasLaunched(pendingRestart, "0.1.15"), true)
clearPendingUpdateRestart()
assert.equal(readPendingUpdateRestart(), null)

async function run() {
  const data = Buffer.from("Bezgrow genuine updater regression payload")
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicDer = publicKey.export({ type: "spki", format: "der" })
  const rawPublicKey = publicDer.subarray(publicDer.length - 32)
  const keyId = randomBytes(8)
  const primarySignature = sign(null, createHash("blake2b512").update(data).digest(), privateKey)
  const trustedComment = "timestamp:1754006400\tfile:Bezgrow-test-updater"
  const globalSignature = sign(null, Buffer.concat([primarySignature, Buffer.from(trustedComment)]), privateKey)
  const signatureText = [
    "untrusted comment: signature from Bezgrow updater test key",
    Buffer.concat([Buffer.from("ED"), keyId, primarySignature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
  ].join("\n")
  const publicKeyText = [
    "untrusted comment: Bezgrow updater test public key",
    Buffer.concat([Buffer.from("ED"), keyId, rawPublicKey]).toString("base64"),
  ].join("\n")
  const directory = await mkdtemp(join(tmpdir(), "bezgrow-updater-test-"))
  const file = join(directory, "Bezgrow-test-updater.bin")
  await writeFile(file, data)
  const hash = createHash("sha256").update(data).digest("hex")
  const verified = await verifyUpdaterArtifact({
    url: "https://verification.invalid/updater",
    localFilePath: file,
    sha256: hash,
    signature: Buffer.from(signatureText).toString("base64"),
    publicKey: Buffer.from(publicKeyText).toString("base64"),
  })
  assert.equal(verified.signatureValid, true)
  assert.equal(verified.sha256, hash)
  assert.equal(verified.size, data.length)
  await assert.rejects(
    verifyUpdaterArtifact({
      url: "https://verification.invalid/updater",
      localFilePath: file,
      sha256: "0".repeat(64),
      signature: Buffer.from(signatureText).toString("base64"),
      publicKey: Buffer.from(publicKeyText).toString("base64"),
    }),
    /SHA-256 mismatch/,
  )

  console.log("updater-system-ok safe-delay=48h platform-match=strict launch-confirmation=valid sha256=valid minisign-ed25519=valid tamper-rejected=true")
}

void run()
