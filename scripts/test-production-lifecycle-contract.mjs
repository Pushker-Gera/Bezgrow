import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const dashboard = read("app/dashboard/layout.tsx")
const profile = read("app/profile/page.tsx")
const login = read("app/login/page.tsx")
const offline = read("app/offline/page.tsx")
const license = read("lib/offline/local/license.ts")
const settings = read("app/dashboard/settings/page.tsx")
const rust = read("src-tauri/src/lib.rs")

assert.match(dashboard, /\/offline\?reason=logged_out&next=%2Fdashboard/, "Dashboard logout must return to the licence screen")
assert.match(profile, /\/offline\?reason=logged_out/, "Profile logout must return to the licence screen")
assert.doesNotMatch(dashboard, /router\.replace\("\/login"\)/, "Ordinary desktop logout must not open cloud login")
assert.match(login, /isDesktopExplicitlyLoggedOut\(\)[\s\S]*\/offline\?reason=logged_out/, "Desktop login bootstrap must honour an explicit local logout")
assert.match(offline, /Licence Active/, "The licence screen must show stored active status")
assert.match(offline, /Continue \/ Open Dashboard/, "The licence screen must allow continuation without repasting a key")
assert.match(offline, /restoreLicensedWorkspaceContext/, "Continuation must verify and restore the signed local licence")
assert.match(offline, /postLogout/, "Post-logout licence display must not auto-enter a new session")
assert.match(license, /desktop_get_or_create_device_id/, "Desktop identity must be authoritative in the native app-data folder")
assert.match(rust, /INSTALLATION_DIRECTORY: &str = "Installation"/, "Device identity must live under application data")
assert.match(rust, /OpenOptions::new\(\)\.write\(true\)\.create_new\(true\)/, "Installation identity files must not be overwritten")
assert.match(rust, /INSTALLATION_SEED_FILENAME/, "A persisted seed must regenerate the same ID if its derived mirror is lost")
assert.match(settings, /Remove licence from this device/, "Licence removal must be a separate Settings action")
assert.match(settings, /REMOVE_LICENSE_CONFIRMATION/, "Licence removal must require protected confirmation")
assert.match(license, /deleteDesktopSecret\(LICENSE_SECRET_KEY\)/, "Explicit removal must delete only the signed licence secret")
assert.doesNotMatch(license, /removeLocalLicenseFromDevice[\s\S]*deleteDesktopSecret\(DEVICE_SECRET_KEY\)/, "Explicit licence removal must preserve the device identity")

const testRoot = mkdtempSync(join(tmpdir(), "bezgrow-e2e-production-"))
const databasePath = join(testRoot, "E2E-local.db")
const updateCopyPath = join(testRoot, "E2E-update-copy.db")
let database = new DatabaseSync(databasePath)
try {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE installation (device_id TEXT PRIMARY KEY);
    CREATE TABLE licenses (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, signed_key TEXT NOT NULL, status TEXT NOT NULL, expiry_date TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, business_id TEXT NOT NULL);
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, stock REAL NOT NULL);
    CREATE TABLE invoices (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), taxable REAL NOT NULL, cgst REAL NOT NULL, sgst REAL NOT NULL, total REAL NOT NULL);
    CREATE TABLE invoice_items (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), product_id TEXT NOT NULL REFERENCES products(id));
    INSERT INTO installation VALUES ('E2E-BZG-STABLE-DEVICE-0001');
    INSERT INTO licenses VALUES ('E2E-LICENCE-1', 'E2E-BZG-STABLE-DEVICE-0001', 'E2E-SIGNED-LOCAL-LICENCE', 'active', '2099-12-31');
    INSERT INTO sessions VALUES ('E2E-SESSION-1', 'E2E-BUSINESS-1');
    INSERT INTO customers VALUES ('E2E-CUSTOMER-1', 'E2E-Customer Monika');
    INSERT INTO products VALUES ('E2E-PRODUCT-1', 'E2E-Product', 10);
    INSERT INTO invoices VALUES ('E2E-INVOICE-1', 'E2E-CUSTOMER-1', 1000, 90, 90, 1180);
    INSERT INTO invoice_items VALUES ('E2E-ITEM-1', 'E2E-INVOICE-1', 'E2E-PRODUCT-1');
  `)
  const gst = database.prepare("SELECT taxable, cgst, sgst, total FROM invoices WHERE id = 'E2E-INVOICE-1'").get()
  assert.equal(gst.taxable + gst.cgst + gst.sgst, gst.total, "E2E GST total must balance")

  database.prepare("DELETE FROM sessions WHERE id = ?").run("E2E-SESSION-1")
  assert.equal(database.prepare("SELECT COUNT(*) count FROM sessions").get().count, 0)
  for (const table of ["installation", "licenses", "customers", "products", "invoices", "invoice_items"]) {
    assert.equal(database.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 1, `logout erased E2E ${table}`)
  }
  database.close()
  database = new DatabaseSync(databasePath)
  assert.equal(database.prepare("SELECT device_id FROM installation").get().device_id, "E2E-BZG-STABLE-DEVICE-0001")
  assert.equal(database.prepare("SELECT status FROM licenses").get().status, "active")
  database.close()

  copyFileSync(databasePath, updateCopyPath)
  database = new DatabaseSync(updateCopyPath)
  assert.equal(database.prepare("SELECT device_id FROM installation").get().device_id, "E2E-BZG-STABLE-DEVICE-0001")
  assert.equal(database.prepare("SELECT COUNT(*) count FROM invoices WHERE id LIKE 'E2E-%'").get().count, 1)
  assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok")
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)
  console.log("production-lifecycle-contract-ok e2e_records=4 logout_preserved=true update_copy_preserved=true")
} finally {
  try { database.close() } catch {}
  rmSync(testRoot, { recursive: true, force: true })
}
