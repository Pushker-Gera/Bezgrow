import assert from "node:assert/strict"
import { pbkdf2Sync, randomBytes, randomUUID, webcrypto } from "node:crypto"
import { runInNewContext } from "node:vm"
import { build } from "esbuild"

// Run the real client code, replacing only the native IPC and SQLite adapters.
// This is not an OS-persistence test; credential_persistence.rs covers that.
const bundle = await build({
  entryPoints: ["lib/app-lock/client.ts"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  plugins: [{
    name: "app-lock-storage-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/(desktop\/tauri|offline\/db)$/ }, ({ path }) => ({ path, namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path.endsWith("tauri")
          ? "export const isTauriRuntimeAsync = async () => true; export const invokeTauri = (...args) => globalThis.fixture.invoke(...args)"
          : "export const getOfflineMeta = (...args) => globalThis.fixture.getMeta(...args); export const setOfflineMeta = (...args) => globalThis.fixture.setMeta(...args)",
      }))
    },
  }],
})

const deviceId = "BZG-CLIENT-PERSISTENCE-FIXTURE"
const licenseId = "license-client-fixture"
const businessId = "business-client-fixture"
const secretKey = "bezgrow-app-lock-v1"
const watermarkKey = "bezgrow_app_lock_watermark_v1"

function credential(password, { reset = false, issuedAt = Date.now() } = {}) {
  const salt = randomBytes(16)
  return {
    version: 1,
    algorithm: "pbkdf2-sha256",
    iterations: 600_000,
    salt: salt.toString("base64url"),
    verifier: pbkdf2Sync(`${deviceId}\0${password}`, salt, 600_000, 32, "sha256").toString("base64url"),
    device_id: deviceId,
    credential_id: randomUUID(),
    issued_at: new Date(issuedAt).toISOString(),
    reset_authorization: reset ? {
      id: randomUUID(),
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + 30 * 60_000).toISOString(),
    } : null,
  }
}

function storage() {
  return { secrets: new Map(), meta: new Map(), dropWrites: false, failMeta: false, reads: 0, afterRead: null }
}

function client(store) {
  const events = []
  const fixtureModule = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module: fixtureModule,
    exports: fixtureModule.exports,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    atob,
    btoa,
    Event,
    CustomEvent,
    navigator: { platform: "MacIntel", userAgent: "fixture", onLine: false },
    window: { dispatchEvent: (event) => { events.push(event.type === "bezgrow:app-lock-provisioning-status" ? event.detail : event.type) } },
    fixture: {
      async invoke(command, args) {
        assert.equal(args.key, secretKey, "There must be exactly one canonical app-lock store")
        if (command === "store_secret") {
          if (!store.dropWrites) store.secrets.set(args.key, args.value)
        } else if (command === "read_secret") {
          const value = store.secrets.get(args.key) || null
          store.reads += 1
          store.afterRead?.(store.reads)
          return value
        } else throw new Error("Unexpected native command")
      },
      async getMeta(key, fallback) { return store.meta.get(key) ?? fallback },
      async setMeta(key, value) {
        if (store.failMeta) throw new Error("Fixture metadata write failed")
        // Match normalized SQLite's scalar-only storage behavior.
        assert.equal(typeof value, "string")
        store.meta.set(key, value)
      },
    },
  })
  return { ...fixtureModule.exports, events }
}

const store = storage()
let app = client(store)
assert.equal((await app.getAppLockStatus()).enabled, false)
assert.equal((await app.getAppLockDiagnostics()).state, "PROVISIONING_REQUIRED")
const first = credential("123456", { issuedAt: Date.now() - 60_000 })
const install = (target, value) => target.provisionAppLockFromLicense(value, deviceId, licenseId, businessId)
await install(app, first)
assert.equal((await app.getAppLockStatus()).enabled, true)
assert.equal((await app.getAppLockDiagnostics()).state, "LOCKED")
assert.ok(app.events.includes("credential-received"))
assert.ok(app.events.includes("installing"))
assert.ok(app.events.includes("ready"))
assert.ok(app.events.includes("bezgrow:app-lock-credential-changed"))
assert.equal(await app.verifyAppPassword("Wrong123"), false)
assert.equal(await app.verifyAppPassword("123456"), true)
assert.equal(typeof store.meta.get(watermarkKey), "string")
assert.equal(JSON.parse(store.meta.get(watermarkKey)).credential_id, first.credential_id)
assert.equal(store.secrets.get(secretKey).includes('"password"'), false)

// Reloading the module represents a fresh process session with the same store.
app = client(store)
assert.equal((await app.getAppLockDiagnostics()).state, "LOCKED")
assert.equal(await app.verifyAppPassword("123456"), true, "Offline unlock must use the retained credential")
const reset = credential("ABC123", { reset: true })
await install(app, reset)
assert.equal(await app.verifyAppPassword("123456"), false)
assert.equal(await app.verifyAppPassword("ABC123"), true)
app = client(store)
assert.equal(await app.verifyAppPassword("ABC123"), true)
const retained = store.secrets.get(secretKey)
await install(app, undefined)
await install(app, null)
await install(app, first)
assert.equal(store.secrets.get(secretKey) === retained, true, "Legacy import and renewal must retain the local password")
const stale = credential("Stale123", { reset: true, issuedAt: Date.now() - 30_000 })
await install(app, stale)
assert.equal(await app.verifyAppPassword("ABC123"), true, "An older refresh must not roll back the latest reset")

// Recover a legacy NULL or interrupted metadata write from canonical storage.
store.meta.set(watermarkKey, null)
await install(app, reset)
assert.equal(JSON.parse(store.meta.get(watermarkKey)).applied_reset_authorization_id, reset.reset_authorization.id)

const lostStore = storage()
lostStore.meta = new Map(store.meta)
const lost = client(lostStore)
await install(lost, reset)
assert.equal((await lost.getAppLockStatus()).enabled, false, "A consumed reset must not be replayed after secure-store loss")
const expired = credential("Expiry123", { reset: true, issuedAt: Date.now() - 31 * 60_000 })
await assert.rejects(install(client(storage()), expired), /expired/)
await assert.rejects(install(client(storage()), { ...reset, device_id: "BZG-OTHER-DEVICE" }), /another device/)
await assert.rejects(install(client(storage()), { ...reset, reset_authorization: { ...reset.reset_authorization, expires_at: "invalid" } }), /does not contain/)

// Reproduce the former keyring mock: writing succeeds, next read is empty.
const dropped = storage()
dropped.dropWrites = true
const broken = client(dropped)
await assert.rejects(install(broken, first), /could not be saved/)
assert.equal(broken.events.includes("ready"), false)
assert.equal(broken.events.includes("bezgrow:app-lock-credential-changed"), false)

// A watermark write failure must not hide an already-persisted credential.
const interrupted = storage()
interrupted.failMeta = true
const recovering = client(interrupted)
await assert.rejects(install(recovering, reset), /metadata write failed/)
assert.equal((await recovering.getAppLockStatus()).enabled, true)
assert.ok(recovering.events.includes("bezgrow:app-lock-credential-changed"))
interrupted.failMeta = false
await install(recovering, reset)
assert.ok(interrupted.meta.get(watermarkKey))

// Deterministically replace the credential between PBKDF2's two store reads.
store.reads = 0
store.afterRead = (count) => {
  if (count === 1) store.secrets.set(secretKey, JSON.stringify({ ...first, license_id: licenseId, business_id: businessId }))
}
assert.equal(await app.verifyAppPassword("ABC123"), false, "A reset during password verification must invalidate that attempt")
store.afterRead = null

console.log("app-lock-client-lifecycle-ok storage=adapter-fixture missing=locked reset=applied restart=offline replay=blocked write_readback=required events=verified")
