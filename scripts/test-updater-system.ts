import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SAFE_AUTO_UPDATE_DELAY_MS,
  autoUpdateDue,
  readUpdateDecision,
  remindLater,
  scheduleUpdate,
} from "../lib/desktop/update-state"
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

  console.log("updater-system-ok safe-delay=48h sha256=valid minisign-ed25519=valid tamper-rejected=true")
}

void run()
