import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { resolve } from "node:path"

const args = process.argv.slice(2)

function arg(name, fallback = "") {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || fallback : fallback
}

const databasePath = resolve(arg("--database"))
const mode = arg("--mode", "verify")
if (!databasePath || !existsSync(databasePath)) {
  throw new Error(`The installed Bezgrow SQLite database is missing: ${databasePath}`)
}
if (!["seed", "verify"].includes(mode)) {
  throw new Error("Mode must be seed or verify.")
}

const ids = {
  organization: "windows-release-smoke-organization",
  product: "windows-release-smoke-product",
  customer: "windows-release-smoke-customer",
  invoice: "windows-release-smoke-invoice",
  invoiceItem: "windows-release-smoke-invoice-item",
  movement: "windows-release-smoke-movement",
  license: "windows-release-smoke-license",
  printSetting: "windows-release-smoke-print-setting",
}

function openDatabase() {
  const database = new DatabaseSync(databasePath)
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
  return database
}

function verify(database) {
  const version = Number(database.prepare("PRAGMA user_version").get().user_version)
  assert.ok(version >= 8, `Expected installed schema version 8 or newer, received ${version}.`)
  assert.equal(
    database.prepare("SELECT name FROM products WHERE id = ?").get(ids.product)?.name,
    "Windows Smoke Product Edited",
    "Edited product did not persist."
  )
  assert.equal(
    database.prepare("SELECT stock FROM products WHERE id = ?").get(ids.product)?.stock,
    18,
    "Invoice stock update did not persist."
  )
  assert.equal(
    database.prepare("SELECT phone FROM customers WHERE id = ?").get(ids.customer)?.phone,
    "+91-9999999999",
    "Edited customer did not persist."
  )
  assert.equal(
    database.prepare("SELECT payment_status FROM sales_invoices WHERE id = ?").get(ids.invoice)?.payment_status,
    "paid",
    "Saved invoice did not persist."
  )
  assert.equal(
    database.prepare("SELECT quantity FROM sales_invoice_items WHERE id = ?").get(ids.invoiceItem)?.quantity,
    2,
    "Invoice line item did not persist."
  )
  assert.equal(
    database.prepare("SELECT new_stock FROM stock_movements WHERE id = ?").get(ids.movement)?.new_stock,
    18,
    "Stock movement did not persist."
  )
  assert.equal(
    database.prepare("SELECT status FROM license_state WHERE id = ?").get(ids.license)?.status,
    "active",
    "Local license state did not persist."
  )
  assert.equal(
    database.prepare("SELECT value_text FROM business_settings WHERE id = ?").get(ids.printSetting)?.value_text,
    "A4",
    "Print preference did not persist."
  )
  assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok")
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)
  return version
}

let database = openDatabase()
try {
  if (mode === "seed") {
    database.exec("BEGIN IMMEDIATE")
    try {
      database.prepare("DELETE FROM sales_invoice_items WHERE id = ?").run(ids.invoiceItem)
      database.prepare("DELETE FROM stock_movements WHERE id = ?").run(ids.movement)
      database.prepare("DELETE FROM sales_invoices WHERE id = ?").run(ids.invoice)
      database.prepare("DELETE FROM license_state WHERE id = ?").run(ids.license)
      database.prepare("DELETE FROM business_settings WHERE id = ?").run(ids.printSetting)
      database.prepare("DELETE FROM products WHERE id = ?").run(ids.product)
      database.prepare("DELETE FROM customers WHERE id = ?").run(ids.customer)
      database.prepare("DELETE FROM organizations WHERE id = ?").run(ids.organization)

      database.prepare(
        "INSERT INTO organizations (id, name, business_name, sync_status) VALUES (?, ?, ?, ?)"
      ).run(ids.organization, "Windows Smoke Business", "Windows Smoke Business", "local")
      database.prepare(
        "INSERT INTO products (id, organization_id, name, sku, price, stock, min_stock, sale_rate, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(ids.product, ids.organization, "Windows Smoke Product", "WIN-SMOKE-001", 250, 20, 2, 250, "local")
      database.prepare("UPDATE products SET name = ?, price = ?, updated_at = datetime('now') WHERE id = ?")
        .run("Windows Smoke Product Edited", 275, ids.product)

      database.prepare(
        "INSERT INTO customers (id, organization_id, name, email, phone, customer_type, is_active, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(ids.customer, ids.organization, "Windows Smoke Customer", "windows-smoke@example.invalid", "+91-9000000000", "retail", 1, "local")
      database.prepare("UPDATE customers SET phone = ?, updated_at = datetime('now') WHERE id = ?")
        .run("+91-9999999999", ids.customer)

      database.prepare(
        `INSERT INTO sales_invoices (
          id, organization_id, customer_id, customer_name, invoice_number, invoice_date,
          subtotal, taxable_amount, total_amount, grand_total, total, paid_amount,
          outstanding_amount, payment_status, status, payment_method, sync_status
        ) VALUES (?, ?, ?, ?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        ids.invoice,
        ids.organization,
        ids.customer,
        "Windows Smoke Customer",
        "WIN-SMOKE-0001",
        550,
        550,
        550,
        550,
        550,
        550,
        0,
        "paid",
        "paid",
        "cash",
        "local"
      )
      database.prepare(
        "INSERT INTO sales_invoice_items (id, organization_id, invoice_id, product_id, product_name, quantity, unit_price, line_total, sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(ids.invoiceItem, ids.organization, ids.invoice, ids.product, "Windows Smoke Product Edited", 2, 275, 550, "local")
      database.prepare("UPDATE products SET stock = stock - 2, updated_at = datetime('now') WHERE id = ?")
        .run(ids.product)
      database.prepare(
        `INSERT INTO stock_movements (
          id, organization_id, product_id, product_name, type, quantity, previous_stock,
          new_stock, reason, reference_type, reference_id, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(ids.movement, ids.organization, ids.product, "Windows Smoke Product Edited", "sale", -2, 20, 18, "Windows release smoke invoice", "sales_invoice", ids.invoice, "local")
      database.prepare(
        `INSERT INTO license_state (
          id, organization_id, license_key, business_id, business_name, status, expiry_date,
          grace_period_days, allowed_features, issued_at, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      ).run(ids.license, ids.organization, "WINDOWS-SMOKE-LICENSE", ids.organization, "Windows Smoke Business", "active", "2099-12-31", 7, "[\"billing\",\"customers\",\"inventory\",\"products\"]", "local")
      database.prepare(
        "INSERT INTO business_settings (id, organization_id, key, value_text) VALUES (?, ?, ?, ?)"
      ).run(ids.printSetting, ids.organization, "print.paper_size", "A4")
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }
} finally {
  database.close()
}

database = openDatabase()
try {
  const version = verify(database)
  console.log(
    `windows-installed-sqlite-crud-ok mode=${mode} schema=${version} product=create-edit customer=create-edit invoice=create-save stock=updated persistence=reopen license=preserved printing=preserved`
  )
} finally {
  database.close()
}
