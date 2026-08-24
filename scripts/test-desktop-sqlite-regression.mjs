import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const tempDir = mkdtempSync(join(tmpdir(), "bezgrow-sqlite-regression-"))
const databasePath = join(tempDir, "fixture.db")
let db = new DatabaseSync(databasePath)

function transaction(work) {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = work()
    db.exec("COMMIT")
    return result
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

try {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE products (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL, sku TEXT, category TEXT, supplier TEXT, stock REAL NOT NULL,
      min_stock REAL NOT NULL DEFAULT 5, sale_rate REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE inventory_items (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL
    );
    CREATE TABLE customers (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL, phone TEXT, email TEXT, gst_number TEXT, customer_type TEXT,
      is_active INTEGER NOT NULL, total_sales REAL NOT NULL DEFAULT 0,
      last_purchase_at TEXT, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE sales_invoices (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id), invoice_number TEXT NOT NULL,
      grand_total REAL NOT NULL, paid_amount REAL NOT NULL, outstanding_amount REAL NOT NULL,
      payment_status TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE sales_invoice_items (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, invoice_id TEXT NOT NULL REFERENCES sales_invoices(id),
      product_id TEXT NOT NULL REFERENCES products(id), quantity REAL NOT NULL, line_total REAL NOT NULL
    );
    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL, reference_id TEXT
    );
    CREATE TABLE ledger_entries (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, document_id TEXT NOT NULL,
      debit REAL NOT NULL, credit REAL NOT NULL
    );
    CREATE TABLE offline_sync_queue (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, operation_type TEXT NOT NULL
    );
    CREATE TABLE business_settings (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, key TEXT NOT NULL, value_boolean INTEGER,
      UNIQUE (organization_id, key)
    );
    CREATE TABLE local_audit_logs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, action TEXT NOT NULL
    );
    CREATE TABLE license_state (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_products_org_sku_unique
      ON products (organization_id, sku COLLATE NOCASE)
      WHERE sku IS NOT NULL AND trim(sku) <> '' AND deleted_at IS NULL;
    CREATE INDEX idx_products_org_active_created ON products (organization_id, deleted_at, created_at DESC);
    CREATE INDEX idx_customers_org_filters ON customers (organization_id, is_active, customer_type, deleted_at);
    CREATE INDEX idx_sales_invoices_org_filters ON sales_invoices (organization_id, payment_status, customer_id, created_at DESC, deleted_at);
  `)

  db.prepare("INSERT INTO organizations VALUES (?, ?)").run("workspace-a", "Workspace A")
  db.prepare("INSERT INTO organizations VALUES (?, ?)").run("workspace-b", "Workspace B")

  transaction(() => {
    db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("p-a1", "workspace-a", "Alpha Medicine", "SKU-A", "medicine", "supplier-a", 10, 3, 100, "2026-01-01")
    db.prepare("INSERT INTO inventory_items VALUES (?, ?, ?, ?)").run("inv-a1", "workspace-a", "p-a1", 10)
    db.prepare("INSERT INTO stock_movements VALUES (?, ?, ?, ?, ?)").run("move-a1", "workspace-a", "p-a1", 10, "opening")
    db.prepare("INSERT INTO offline_sync_queue VALUES (?, ?, ?)").run("action-p-a1", "workspace-a", "save_product")
  })
  transaction(() => {
    db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("p-a2", "workspace-a", "Beta Device", "SKU-B", "device", "supplier-b", 1, 5, 200, "2026-01-02")
    db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("p-b1", "workspace-b", "Alpha Other Workspace", "SKU-A", "medicine", "supplier-a", 50, 5, 999, "2026-01-03")
  })

  assert.throws(() => transaction(() => {
    db.prepare("INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("p-rollback", "workspace-a", "Rollback Product", "SKU-R", "medicine", "supplier-a", 2, 5, 10, "2026-01-04")
    throw new Error("forced product rollback")
  }))
  assert.equal(db.prepare("SELECT COUNT(*) total FROM products WHERE id = 'p-rollback'").get().total, 0)

  const productSearch = db.prepare(`
    SELECT id FROM products
    WHERE organization_id = ? AND deleted_at IS NULL
      AND (name LIKE ? COLLATE NOCASE OR sku LIKE ? COLLATE NOCASE OR category LIKE ? COLLATE NOCASE OR supplier LIKE ? COLLATE NOCASE)
    ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?
  `)
  assert.deepEqual(productSearch.all("workspace-a", "%alpha%", "%alpha%", "%alpha%", "%alpha%", 1, 0).map((row) => row.id), ["p-a1"])
  assert.deepEqual(productSearch.all("workspace-a", "%a%", "%a%", "%a%", "%a%", 1, 0).map((row) => row.id), ["p-a1"])
  assert.deepEqual(productSearch.all("workspace-a", "%a%", "%a%", "%a%", "%a%", 1, 1).map((row) => row.id), ["p-a2"])
  assert.equal(db.prepare("SELECT COUNT(*) total FROM products WHERE organization_id = ? AND category = ? AND supplier = ? AND stock > 0 AND stock <= min_stock").get("workspace-a", "device", "supplier-b").total, 1)

  transaction(() => {
    db.prepare("INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("c-a1", "workspace-a", "Customer Alpha", "100", "alpha@example.com", "GST-A", "retail", 1, 0, null, "2026-01-01")
    db.prepare("INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("c-b1", "workspace-b", "Customer Alpha", "200", "other@example.com", null, "retail", 1, 0, null, "2026-01-01")
    db.prepare("INSERT INTO offline_sync_queue VALUES (?, ?, ?)").run("action-c-a1", "workspace-a", "save_customer")
  })
  assert.equal(db.prepare("SELECT COUNT(*) total FROM customers WHERE organization_id = ? AND name LIKE ? AND customer_type = ? AND gst_number IS NOT NULL").get("workspace-a", "%Alpha%", "retail").total, 1)

  transaction(() => {
    db.prepare("INSERT INTO sales_invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("invoice-a1", "workspace-a", "c-a1", "INV-00001", 1200, 1200, 0, "paid", "2026-01-05")
    db.prepare("INSERT INTO sales_invoice_items VALUES (?, ?, ?, ?, ?, ?)").run("item-a1", "workspace-a", "invoice-a1", "p-a1", 1, 1000)
    db.prepare("UPDATE products SET stock = stock - 1 WHERE id = ? AND organization_id = ?").run("p-a1", "workspace-a")
    db.prepare("INSERT INTO stock_movements VALUES (?, ?, ?, ?, ?)").run("move-sale-a1", "workspace-a", "p-a1", -1, "invoice-a1")
    db.prepare("INSERT INTO ledger_entries VALUES (?, ?, ?, ?, ?)").run("ledger-sale-a1", "workspace-a", "invoice-a1", 1200, 0)
    db.prepare("INSERT INTO ledger_entries VALUES (?, ?, ?, ?, ?)").run("ledger-revenue-a1", "workspace-a", "invoice-a1", 0, 1200)
    db.prepare("UPDATE customers SET total_sales = total_sales + 1200, last_purchase_at = ? WHERE id = ?").run("2026-01-05", "c-a1")
    db.prepare("INSERT INTO offline_sync_queue VALUES (?, ?, ?)").run("action-invoice-a1", "workspace-a", "create_invoice")
  })
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'p-a1'").get().stock, 9)
  assert.equal(db.prepare("SELECT SUM(debit) debit, SUM(credit) credit FROM ledger_entries WHERE document_id = 'invoice-a1'").get().debit, 1200)
  assert.equal(db.prepare("SELECT SUM(debit) debit, SUM(credit) credit FROM ledger_entries WHERE document_id = 'invoice-a1'").get().credit, 1200)
  const customerSummary = db.prepare(`
    SELECT c.id, COUNT(i.id) invoice_count, COALESCE(SUM(i.grand_total), c.total_sales) revenue, MAX(i.created_at) last_purchase
    FROM customers c LEFT JOIN sales_invoices i
      ON i.organization_id = c.organization_id AND i.customer_id = c.id AND i.deleted_at IS NULL
    WHERE c.organization_id = ? AND c.deleted_at IS NULL
    GROUP BY c.id
  `).get("workspace-a")
  assert.deepEqual({ count: customerSummary.invoice_count, revenue: customerSummary.revenue }, { count: 1, revenue: 1200 })

  assert.throws(() => transaction(() => {
    db.prepare("INSERT INTO sales_invoices VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")
      .run("invoice-rollback", "workspace-a", "c-a1", "INV-ROLLBACK", 50, 0, 50, "unpaid", "2026-01-06")
    db.prepare("UPDATE products SET stock = stock - 5 WHERE id = 'p-a1'").run()
    throw new Error("forced invoice rollback")
  }))
  assert.equal(db.prepare("SELECT COUNT(*) total FROM sales_invoices WHERE id = 'invoice-rollback'").get().total, 0)
  assert.equal(db.prepare("SELECT stock FROM products WHERE id = 'p-a1'").get().stock, 9)

  transaction(() => {
    db.prepare("INSERT INTO business_settings VALUES (?, ?, ?, ?)").run("setting-pos", "workspace-a", "pos_billing", 1)
    db.prepare("INSERT INTO local_audit_logs VALUES (?, ?, ?)").run("audit-pos", "workspace-a", "settings.feature_toggled")
    db.prepare("INSERT INTO license_state VALUES (?, ?, ?)").run("license-a", "workspace-a", "active")
  })

  // Regression: the former product/customer save path deleted every synced row
  // before reinserting it. Production invoice foreign keys use ON DELETE SET
  // NULL, so a closed-year trigger rejects that cascade with
  // `financial_year_closed`. This made even an unrelated Add Product fail.
  db.exec(`
    CREATE TABLE closed_financial_years (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE closed_products (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE closed_customers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE closed_invoices (
      id TEXT PRIMARY KEY,
      financial_year_id TEXT NOT NULL REFERENCES closed_financial_years(id),
      customer_id TEXT REFERENCES closed_customers(id) ON DELETE SET NULL
    );
    CREATE TABLE closed_invoice_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL REFERENCES closed_invoices(id),
      product_id TEXT REFERENCES closed_products(id) ON DELETE SET NULL
    );
    CREATE TRIGGER closed_invoice_customer_guard
      BEFORE UPDATE OF customer_id ON closed_invoices
      WHEN EXISTS (SELECT 1 FROM closed_financial_years fy WHERE fy.id = OLD.financial_year_id AND fy.status <> 'OPEN')
      BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END;
    CREATE TRIGGER closed_invoice_item_product_guard
      BEFORE UPDATE OF product_id ON closed_invoice_items
      WHEN EXISTS (
        SELECT 1 FROM closed_invoices invoice
        JOIN closed_financial_years fy ON fy.id = invoice.financial_year_id
        WHERE invoice.id = OLD.invoice_id AND fy.status <> 'OPEN'
      )
      BEGIN SELECT RAISE(ABORT, 'financial_year_closed'); END;
    INSERT INTO closed_financial_years VALUES ('fy-closed', 'CLOSED');
    INSERT INTO closed_products VALUES ('closed-product', 'Historical Product');
    INSERT INTO closed_customers VALUES ('closed-customer', 'Historical Customer');
    INSERT INTO closed_invoices VALUES ('closed-invoice', 'fy-closed', 'closed-customer');
    INSERT INTO closed_invoice_items VALUES ('closed-item', 'closed-invoice', 'closed-product');
  `)
  assert.throws(() => transaction(() => db.exec("DELETE FROM closed_products")), /financial_year_closed/)
  assert.throws(() => transaction(() => db.exec("DELETE FROM closed_customers")), /financial_year_closed/)

  transaction(() => {
    db.prepare("UPDATE closed_products SET name = ? WHERE id = ?").run("Historical Product Updated", "closed-product")
    db.prepare("INSERT INTO closed_products VALUES (?, ?)").run("new-product", "New Product")
    db.prepare("UPDATE closed_customers SET name = ? WHERE id = ?").run("Historical Customer Updated", "closed-customer")
    db.prepare("INSERT INTO closed_customers VALUES (?, ?)").run("new-customer", "New Customer")
  })
  assert.equal(db.prepare("SELECT product_id FROM closed_invoice_items WHERE id = 'closed-item'").get().product_id, "closed-product")
  assert.equal(db.prepare("SELECT customer_id FROM closed_invoices WHERE id = 'closed-invoice'").get().customer_id, "closed-customer")
  assert.equal(db.prepare("SELECT COUNT(*) total FROM closed_products").get().total, 2)
  assert.equal(db.prepare("SELECT COUNT(*) total FROM closed_customers").get().total, 2)

  db.close()
  db = new DatabaseSync(databasePath)
  assert.equal(db.prepare("SELECT status FROM license_state WHERE organization_id = 'workspace-a'").get().status, "active")
  assert.equal(db.prepare("SELECT COUNT(*) total FROM products WHERE organization_id = 'workspace-a'").get().total, 2)
  assert.equal(db.prepare("SELECT COUNT(*) total FROM customers WHERE organization_id = 'workspace-a'").get().total, 1)
  assert.equal(db.prepare("SELECT COUNT(*) total FROM sales_invoices WHERE organization_id = 'workspace-a'").get().total, 1)
  assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok")
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0)

  console.log("desktop-sqlite-regression-ok")
} finally {
  db.close()
  rmSync(tempDir, { recursive: true, force: true })
}
