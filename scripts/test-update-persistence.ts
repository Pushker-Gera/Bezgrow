import assert from "node:assert/strict"
import { createPrivateKey, generateKeyPairSync, pbkdf2Sync, sign } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import packageJson from "../package.json"
import {
  APP_LOCK_ALGORITHM,
  APP_LOCK_ITERATIONS,
  APP_LOCK_KEY_BYTES,
  type AppLockProvisioning,
} from "../lib/app-lock/shared"
import { verifyAppLockPassword } from "../lib/app-lock/verification"
import {
  canonicalLicenseText,
  encodeLicenseKey,
  parseLicenseInput,
  verifyLicenseSignature,
  type LicensePayload,
} from "../lib/license/codec"
import { evaluateStoredLicense, type StoredLicenseRow } from "../lib/license/policy"
import { verifyStoredLicenseRows } from "../lib/license/verification"

const DEVICE_ID = "BZG-23D76F50F880422489AF152B"
const APP_PASSWORD = "UpgradeSafe9"
const BUSINESS_ID = "business-update-fixture"
const LICENSE_ID = "license-update-fixture"
const LEGACY_VERSIONS = ["0.2.2", "0.2.3"] as const

type FixtureSnapshot = {
  deviceId: string
  adminKey: string
  appLock: string
  logo: string
  backup: string
  rows: Record<string, number>
  business: Record<string, unknown>
  settings: Record<string, unknown>
}

function rawKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const privateJwk = privateKey.export({ format: "jwk" })
  const publicJwk = publicKey.export({ format: "jwk" })
  return {
    privateKey: createPrivateKey({ key: privateJwk, format: "jwk" }),
    publicKey: String(publicJwk.x),
  }
}

function signPayload(payload: LicensePayload, privateKey: ReturnType<typeof createPrivateKey>) {
  const signedPayload: LicensePayload = {
    ...payload,
    allowed_features: [...payload.allowed_features].sort(),
    signature_algorithm: "ed25519",
    issuer_key_id: "ed25519_update_fixture",
  }
  const signature = sign(null, new TextEncoder().encode(canonicalLicenseText(signedPayload)), privateKey)
  return encodeLicenseKey(signedPayload, signature)
}

function appLockCredential(): AppLockProvisioning {
  const salt = Buffer.from("0123456789abcdef", "utf8")
  return {
    version: 1,
    algorithm: APP_LOCK_ALGORITHM,
    iterations: APP_LOCK_ITERATIONS,
    salt: salt.toString("base64url"),
    verifier: pbkdf2Sync(`${DEVICE_ID}\u0000${APP_PASSWORD}`, salt, APP_LOCK_ITERATIONS, APP_LOCK_KEY_BYTES, "sha256").toString("base64url"),
    device_id: DEVICE_ID,
    credential_id: "credential-update-fixture",
    issued_at: "2026-08-01T00:00:00.000Z",
    reset_authorization: null,
  }
}

function createVersionNFixture(root: string, licenseKey: string, appLock: AppLockProvisioning) {
  const installation = join(root, "Installation")
  const assets = join(root, "business-assets", "logos")
  const backups = join(root, "Backups")
  const secureStorage = join(root, "secure-storage-fixture")
  for (const directory of [installation, assets, backups, secureStorage]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(installation, "device-id"), DEVICE_ID)
  writeFileSync(join(installation, "platform-admin-device-signing-key"), "a".repeat(64))
  writeFileSync(join(assets, "business-logo.png"), "representative-business-logo")
  writeFileSync(join(backups, "version-n.bezgrow-backup"), "representative-backup")
  writeFileSync(join(secureStorage, "app-lock.json"), JSON.stringify(appLock))

  const database = new DatabaseSync(join(root, "bezgrow-offline.db"))
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, joined_date TEXT NOT NULL);
    CREATE TABLE license_state (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, license_key TEXT NOT NULL, device_id TEXT NOT NULL, status TEXT NOT NULL, expiry_date TEXT NOT NULL, grace_period_days INTEGER NOT NULL, last_verified_at TEXT NOT NULL, allowed_features TEXT NOT NULL, issued_at TEXT NOT NULL);
    CREATE TABLE business_settings (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, setting_key TEXT NOT NULL, setting_value TEXT NOT NULL);
    CREATE TABLE products (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE customers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, customer_id TEXT NOT NULL, invoice_number TEXT NOT NULL);
    CREATE TABLE sales_invoice_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, invoice_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity REAL NOT NULL);
    CREATE TABLE inventory_items (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, stock REAL NOT NULL);
    CREATE TABLE stock_movements (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity REAL NOT NULL);
    CREATE TABLE suppliers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE warehouses (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE financial_years (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE print_templates (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, paper_size TEXT NOT NULL);
  `)
  database.prepare("INSERT INTO organizations VALUES (?, ?, ?)").run(BUSINESS_ID, "Upgrade Fixture Business", "2026-07-01")
  database.prepare("INSERT INTO license_state VALUES (?, ?, ?, ?, 'active', '2099-12-31', 7, '2026-08-01T00:00:00.000Z', ?, '2026-08-01T00:00:00.000Z')")
    .run(LICENSE_ID, BUSINESS_ID, licenseKey, DEVICE_ID, JSON.stringify(["billing", "inventory"]))
  for (const [key, value] of [
    ["business_profile", JSON.stringify({ legalName: "Upgrade Fixture Business", gstin: "07AAAAA0000A1Z5" })],
    ["business_logo", "business-assets/logos/business-logo.png"],
    ["print_settings", JSON.stringify({ paperSize: "A4", copies: 2 })],
    ["app_lock_delay_ms", "30000"],
  ]) {
    database.prepare("INSERT INTO business_settings VALUES (?, ?, ?, ?)").run(`setting-${key}`, BUSINESS_ID, key, value)
  }
  for (const id of ["product-1", "product-2", "product-3"]) database.prepare("INSERT INTO products VALUES (?, ?, ?)").run(id, BUSINESS_ID, `Product ${id}`)
  for (const id of ["customer-1", "customer-2"]) database.prepare("INSERT INTO customers VALUES (?, ?, ?)").run(id, BUSINESS_ID, `Customer ${id}`)
  database.prepare("INSERT INTO warehouses VALUES ('warehouse-1', ?, 'Main Warehouse')").run(BUSINESS_ID)
  database.prepare("INSERT INTO suppliers VALUES ('supplier-1', ?, 'Fixture Supplier')").run(BUSINESS_ID)
  database.prepare("INSERT INTO sales_invoices VALUES ('invoice-1', ?, 'customer-1', 'INV-00001')").run(BUSINESS_ID)
  database.prepare("INSERT INTO sales_invoice_items VALUES ('invoice-item-1', ?, 'invoice-1', 'product-1', 2)").run(BUSINESS_ID)
  database.prepare("INSERT INTO inventory_items VALUES ('inventory-1', ?, 'product-1', 'warehouse-1', 8)").run(BUSINESS_ID)
  database.prepare("INSERT INTO stock_movements VALUES ('movement-1', ?, 'product-1', -2)").run(BUSINESS_ID)
  database.prepare("INSERT INTO financial_years VALUES ('fy-1', ?, '2026-27', 'active')").run(BUSINESS_ID)
  database.prepare("INSERT INTO print_templates VALUES ('print-1', ?, 'A4')").run(BUSINESS_ID)
  database.close()
}

function snapshot(root: string): FixtureSnapshot {
  const database = new DatabaseSync(join(root, "bezgrow-offline.db"), { readOnly: true })
  const tables = [
    "organizations", "license_state", "business_settings", "products", "customers", "sales_invoices",
    "sales_invoice_items", "inventory_items", "stock_movements", "suppliers", "warehouses", "financial_years", "print_templates",
  ]
  const rows = Object.fromEntries(tables.map((table) => [table, Number((database.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count)]))
  const business = database.prepare("SELECT * FROM organizations WHERE id = ?").get(BUSINESS_ID) as Record<string, unknown>
  const settings = Object.fromEntries((database.prepare("SELECT setting_key, setting_value FROM business_settings WHERE organization_id = ? ORDER BY setting_key").all(BUSINESS_ID) as Array<{ setting_key: string; setting_value: string }>).map((row) => [row.setting_key, row.setting_value]))
  database.close()
  return {
    deviceId: readFileSync(join(root, "Installation", "device-id"), "utf8"),
    adminKey: readFileSync(join(root, "Installation", "platform-admin-device-signing-key"), "utf8"),
    appLock: readFileSync(join(root, "secure-storage-fixture", "app-lock.json"), "utf8"),
    logo: readFileSync(join(root, "business-assets", "logos", "business-logo.png"), "utf8"),
    backup: readFileSync(join(root, "Backups", "version-n.bezgrow-backup"), "utf8"),
    rows,
    business,
    settings,
  }
}

async function main() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "bezgrow-update-persistence-"))
  try {
    const baseConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"))
    const windowsConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8"))
    assert.equal(baseConfig.productName, "Bezgrow")
    assert.equal(baseConfig.mainBinaryName, "Bezgrow")
    assert.equal(baseConfig.identifier, "com.bezgrow.erp")
    assert.equal(windowsConfig.bundle.windows.nsis.installMode, "perMachine")
    assert.equal(baseConfig.version, packageJson.version)

    const keys = rawKeys()
    const results: Array<{ from: string; quickCheck: string; foreignKeyViolations: number }> = []
    for (const legacyVersion of LEGACY_VERSIONS) {
    const legacyPayload: LicensePayload = {
      schema_version: 1,
      license_id: LICENSE_ID,
      customer_id: "customer-update-fixture",
      customer_name: "Update Fixture Owner",
      customer_email: "fixture@example.invalid",
      business_id: BUSINESS_ID,
      business_name: "Upgrade Fixture Business",
      device_id: DEVICE_ID,
      platform: "macos",
      architecture: "arm64",
      app_version: legacyVersion,
      plan_name: "Offline ERP",
      expiry_date: "2099-12-31",
      grace_period_days: 7,
      allowed_features: ["inventory", "billing"],
      issued_by_admin: "fixture-admin",
      issued_at: "2026-08-01T00:00:00.000Z",
      notes: null,
      // Intentionally no app_lock: v0.2.3 previously added null while parsing
      // this payload and thereby invalidated its genuine signature.
    }
    const licenseKey = signPayload(legacyPayload, keys.privateKey)
    const parsed = parseLicenseInput(licenseKey)
    assert.equal(Object.hasOwn(parsed.payload, "app_lock"), false, "An absent signed optional field must remain absent.")
    assert.equal(await verifyLicenseSignature(parsed, keys.publicKey), true, "The Version N signature must verify in Version N+1.")

    const appLock = appLockCredential()
    const canonicalRoot = join(fixtureRoot, legacyVersion, "Application Support", "com.bezgrow.erp")
    createVersionNFixture(canonicalRoot, licenseKey, appLock)
    const before = snapshot(canonicalRoot)

    // macOS replaces Bezgrow.app but never this bundle-ID-derived data root.
    // This copy represents an independent support snapshot, not a migration or
    // a second live ERP database.
    const supportSnapshot = join(fixtureRoot, legacyVersion, "support-snapshot")
    cpSync(canonicalRoot, supportSnapshot, { recursive: true })

    const database = new DatabaseSync(join(canonicalRoot, "bezgrow-offline.db"), { readOnly: true })
    const row = database.prepare("SELECT * FROM license_state WHERE id = ?").get(LICENSE_ID) as StoredLicenseRow
    const quickCheck = String(database.prepare("PRAGMA quick_check").get()?.quick_check || "")
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length
    database.close()
    assert.equal(quickCheck, "ok", `${legacyVersion} upgrade fixture failed SQLite quick_check.`)
    assert.equal(foreignKeyViolations, 0, `${legacyVersion} upgrade fixture has foreign-key violations.`)
    const verified = await verifyStoredLicenseRows([row], { publicKey: keys.publicKey, deviceId: DEVICE_ID })
    assert.equal(verified.length, 1)
    assert.equal(evaluateStoredLicense(verified, { deviceId: DEVICE_ID, now: new Date("2026-08-24T00:00:00.000Z") }).allowed, true)
    assert.equal(evaluateStoredLicense([{ ...verified[0], status: "suspended" }], { deviceId: DEVICE_ID }).allowed, false)
    assert.equal(evaluateStoredLicense([{ ...verified[0], status: "revoked" }], { deviceId: DEVICE_ID }).allowed, false)
    assert.equal(evaluateStoredLicense([{ ...verified[0], expiry_date: "2020-01-01", expires_at: "2020-01-01", grace_period_days: 0 }], { deviceId: DEVICE_ID }).allowed, false)

    assert.equal(await verifyAppLockPassword(APP_PASSWORD, appLock), true)
    const after = snapshot(canonicalRoot)
    assert.deepEqual(after, before, "Opening Version N data with Version N+1 must not alter or duplicate installation data.")
    assert.deepEqual(snapshot(supportSnapshot), before, "The representative support snapshot must retain every Version N record.")
    assert.equal(after.deviceId, DEVICE_ID)
    assert.equal(after.rows.products, 3)
    assert.equal(after.rows.customers, 2)
    assert.equal(after.rows.sales_invoices, 1)
    assert.equal(after.rows.sales_invoice_items, 1)
    assert.equal(after.rows.stock_movements, 1)
    assert.equal(after.rows.financial_years, 1)
    assert.equal(after.settings.business_logo, "business-assets/logos/business-logo.png")
    assert.match(String(after.settings.print_settings), /"copies":2/)

    const launcher = readFileSync(new URL("../components/desktop/PlatformAdminLauncher.tsx", import.meta.url), "utf8")
    assert.match(launcher, /verifyThisPlatformAdminDevice/)
    assert.doesNotMatch(launcher, /getExplicitControlPlaneActionAuth|localLicenseSnapshot/)
    results.push({ from: legacyVersion, quickCheck, foreignKeyViolations })
    }

    console.log(`update-persistence-ok from=${results.map((result) => result.from).join(",")} to=${packageJson.version} device=stable license=verified data=unchanged app_lock=unchanged admin_entry=license-independent quick_check=${results.every((result) => result.quickCheck === "ok") ? "ok" : "failed"} foreign_keys=${results.reduce((sum, result) => sum + result.foreignKeyViolations, 0)}`)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

void main()
