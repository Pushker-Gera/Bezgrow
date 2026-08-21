import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

type Sample = { p50Ms: number; p95Ms: number; worstMs: number; iterations: number }

const tiers = [1_000, 5_000, 10_000]
const root = mkdtempSync(path.join(tmpdir(), "bezgrow-admin-scale-"))

function round(value: number) {
  return Number(value.toFixed(3))
}

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] || 0
}

function measure(iterations: number, operation: () => unknown): Sample {
  const values: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    operation()
    values.push(performance.now() - started)
  }
  return {
    p50Ms: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    worstMs: round(Math.max(...values)),
    iterations,
  }
}

function createFixture(databasePath: string, rowCount: number) {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE platform_customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE platform_businesses (
      id TEXT PRIMARY KEY, platform_customer_id TEXT NOT NULL, workspace_id TEXT NOT NULL UNIQUE,
      business_name TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(platform_customer_id) REFERENCES platform_customers(id)
    );
    CREATE TABLE licenses (
      id TEXT PRIMARY KEY, platform_customer_id TEXT NOT NULL, platform_business_id TEXT NOT NULL,
      customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, business_name TEXT NOT NULL,
      device_id TEXT NOT NULL, platform TEXT NOT NULL, architecture TEXT NOT NULL,
      plan_name TEXT NOT NULL, expiry_date TEXT NOT NULL, status TEXT NOT NULL,
      idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(platform_customer_id) REFERENCES platform_customers(id),
      FOREIGN KEY(platform_business_id) REFERENCES platform_businesses(id)
    );
    CREATE TABLE registered_devices (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, license_id TEXT NOT NULL UNIQUE,
      platform_business_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(license_id) REFERENCES licenses(id),
      FOREIGN KEY(platform_business_id) REFERENCES platform_businesses(id)
    );
    CREATE INDEX idx_admin_license_created ON licenses(created_at DESC);
    CREATE INDEX idx_admin_license_status_platform_created ON licenses(status,platform,created_at DESC);
    CREATE INDEX idx_admin_license_device ON licenses(device_id,created_at DESC);
    CREATE INDEX idx_admin_license_customer ON licenses(platform_customer_id,created_at DESC);
    CREATE INDEX idx_admin_license_business ON licenses(platform_business_id,created_at DESC);
    CREATE INDEX idx_admin_business_customer ON platform_businesses(platform_customer_id,created_at DESC);
    CREATE INDEX idx_admin_device_business ON registered_devices(platform_business_id,created_at DESC);
  `)
  const insertCustomer = db.prepare("INSERT INTO platform_customers VALUES (?,?,?,?)")
  const insertBusiness = db.prepare("INSERT INTO platform_businesses VALUES (?,?,?,?,?)")
  const insertLicense = db.prepare("INSERT INTO licenses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  const insertDevice = db.prepare("INSERT INTO registered_devices VALUES (?,?,?,?,?,?)")
  db.exec("BEGIN IMMEDIATE")
  try {
    for (let index = 0; index < rowCount; index += 1) {
      const suffix = String(index).padStart(6, "0")
      const customerId = `customer-${suffix}`
      const businessId = `business-${suffix}`
      const licenseId = `license-${suffix}`
      const deviceId = `DEVICE-CERT-${suffix}`
      const createdAt = new Date(Date.UTC(2025, 0, 1) + index * 1_000).toISOString()
      const status = index % 13 === 0 ? "revoked" : index % 7 === 0 ? "expired" : "active"
      const platform = index % 2 === 0 ? "windows" : "macos"
      insertCustomer.run(customerId, `Customer ${suffix}`, `customer${suffix}@example.test`, createdAt)
      insertBusiness.run(businessId, customerId, `workspace-${suffix}`, `Business ${suffix}`, createdAt)
      insertLicense.run(
        licenseId,
        customerId,
        businessId,
        `Customer ${suffix}`,
        `customer${suffix}@example.test`,
        `Business ${suffix}`,
        deviceId,
        platform,
        platform === "windows" ? "x64" : "arm64",
        index % 3 === 0 ? "Business" : "Standard",
        "2027-12-31",
        status,
        `idempotency-${suffix}`,
        createdAt,
        createdAt,
      )
      insertDevice.run(`registered-${suffix}`, deviceId, licenseId, businessId, status === "active" ? "active" : "inactive", createdAt)
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  db.exec("PRAGMA foreign_keys=ON; PRAGMA wal_checkpoint(TRUNCATE); ANALYZE; PRAGMA optimize")
  return db
}

function certifyTier(rowCount: number) {
  const databasePath = path.join(root, `admin-${rowCount}.sqlite`)
  const db = createFixture(databasePath, rowCount)
  const page = db.prepare(
    `SELECT id,customer_name,business_name,device_id,platform,status,expiry_date,created_at
     FROM licenses ORDER BY created_at DESC LIMIT 50 OFFSET 100`,
  )
  const filteredPage = db.prepare(
    `SELECT id,customer_name,business_name,device_id,platform,status,expiry_date,created_at
     FROM licenses WHERE status=? AND platform=? ORDER BY created_at DESC LIMIT 50 OFFSET 0`,
  )
  const searchPage = db.prepare(
    `SELECT id,customer_name,business_name,device_id,platform,status,expiry_date,created_at
     FROM licenses
     WHERE id LIKE ? COLLATE NOCASE OR customer_name LIKE ? COLLATE NOCASE OR customer_email LIKE ? COLLATE NOCASE
       OR business_name LIKE ? COLLATE NOCASE OR device_id LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT 50 OFFSET 0`,
  )
  const searchCount = db.prepare(
    `SELECT COUNT(*) AS total FROM licenses
     WHERE id LIKE ? COLLATE NOCASE OR customer_name LIKE ? COLLATE NOCASE OR customer_email LIKE ? COLLATE NOCASE
       OR business_name LIKE ? COLLATE NOCASE OR device_id LIKE ? COLLATE NOCASE`,
  )
  const deviceLookup = db.prepare("SELECT * FROM registered_devices WHERE device_id=? LIMIT 1")
  const businessLookup = db.prepare("SELECT * FROM platform_businesses WHERE workspace_id=? LIMIT 1")
  const term = "%Business 000042%"
  const absent = "%NO-SUCH-CONTROL-PLANE-ROW%"
  const listAndCount = (searchTerm: string) => {
    searchPage.all(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm)
    searchCount.get(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm)
  }

  const benchmarks = {
    licenseListPage: measure(40, () => page.all()),
    licenseFilteredPage: measure(40, () => filteredPage.all("active", "windows")),
    licenseSearchAndExactCount: measure(30, () => listAndCount(term)),
    licenseNoMatchAndExactCount: measure(20, () => listAndCount(absent)),
    deviceLookup: measure(40, () => deviceLookup.get("DEVICE-CERT-000042")),
    businessLookup: measure(40, () => businessLookup.get("workspace-000042")),
    generateLicenseRollback: measure(20, () => {
      db.exec("BEGIN IMMEDIATE")
      try {
        db.prepare("INSERT INTO platform_customers VALUES ('generated-customer','Generated Customer','generated@example.test',datetime('now'))").run()
        db.prepare("INSERT INTO platform_businesses VALUES ('generated-business','generated-customer','generated-workspace','Generated Business',datetime('now'))").run()
        db.prepare(
          `INSERT INTO licenses VALUES (
            'generated-license','generated-customer','generated-business','Generated Customer','generated@example.test',
            'Generated Business','GENERATED-DEVICE','windows','x64','Business','2028-12-31','active',
            'generated-idempotency',datetime('now'),datetime('now'))`,
        ).run()
        db.prepare("INSERT INTO registered_devices VALUES ('generated-registration','GENERATED-DEVICE','generated-license','generated-business','active',datetime('now'))").run()
      } finally {
        db.exec("ROLLBACK")
      }
    }),
    revokeLicenseRollback: measure(30, () => {
      db.exec("BEGIN IMMEDIATE")
      try {
        db.prepare("UPDATE licenses SET status='revoked',updated_at=datetime('now') WHERE id='license-000042'").run()
        db.prepare("UPDATE registered_devices SET status='inactive' WHERE license_id='license-000042'").run()
      } finally {
        db.exec("ROLLBACK")
      }
    }),
    renewLicenseRollback: measure(30, () => {
      db.exec("BEGIN IMMEDIATE")
      try {
        db.prepare("UPDATE licenses SET status='active',expiry_date='2029-12-31',updated_at=datetime('now') WHERE id='license-000042'").run()
      } finally {
        db.exec("ROLLBACK")
      }
    }),
  }

  db.exec("BEGIN IMMEDIATE")
  try {
    assert.throws(
      () => db.prepare("INSERT INTO registered_devices VALUES ('clone','CLONED-DEVICE','license-000042','business-000042','active',datetime('now'))").run(),
      /UNIQUE constraint failed/,
      "A single-device licence must not bind a second registered device.",
    )
  } finally {
    db.exec("ROLLBACK")
  }
  assert.equal((page.all() as unknown[]).length, 50)
  assert.equal((searchCount.get(term, term, term, term, term) as { total: number }).total, 1)
  assert.equal(String(Object.values(db.prepare("PRAGMA quick_check").get() || {})[0]), "ok")
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0)
  for (const [name, sample] of Object.entries(benchmarks)) {
    assert.ok(sample.p95Ms < 500, `${rowCount}/${name} exceeded the 500 ms control-plane fixture ceiling: ${sample.p95Ms} ms`)
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  return { licenses: rowCount, customers: rowCount, businesses: rowCount, devices: rowCount, databaseBytes: statSync(databasePath).size, benchmarks }
}

try {
  const licensesRoute = readFileSync("app/api/admin/licenses/route.ts", "utf8")
  assert.match(licensesRoute, /select\(LICENSE_LIST_COLUMNS, \{ count: "exact" \}\)/)
  assert.match(licensesRoute, /query\.range\(from, to\)/)
  assert.match(licensesRoute, /idempotency_key/)
  const results = tiers.map(certifyTier)
  console.log(JSON.stringify({ fixture: "disposable-sqlite-control-plane-equivalent", results }, null, 2))
  console.log("admin-scale-certification-ok production_rows_created=0")
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
