/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

type Dataset = { name: "A" | "B" | "C"; products: number; customers: number; invoices: number; itemsPerInvoice: number }
type Sample = { p50Ms: number; p95Ms: number; worstMs: number; iterations: number }

const datasets: Dataset[] = [
  { name: "A", products: 2_000, customers: 5_000, invoices: 20_000, itemsPerInvoice: 2 },
  { name: "B", products: 5_000, customers: 10_000, invoices: 50_000, itemsPerInvoice: 2 },
  { name: "C", products: 10_000, customers: 25_000, invoices: 100_000, itemsPerInvoice: 3 },
]
const organizationId = "certification-organization"
const root = mkdtempSync(path.join(tmpdir(), "bezgrow-scale-certification-"))
const keepFixtures = process.env.BEZGROW_KEEP_SCALE_FIXTURES === "1"
const outputPath = process.env.BEZGROW_SCALE_RESULTS || path.join(tmpdir(), "bezgrow-large-scale-results.json")

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

function applyMigrations(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64000")
  for (const migration of localMigrations) {
    for (const statement of migration.sql) {
      try {
        db.exec(statement)
      } catch (error) {
        if (!/^\s*ALTER\s+TABLE/i.test(statement) || !String(error).includes("duplicate column name")) throw error
      }
    }
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, datetime('now'))").run(
      migration.version,
      migration.name,
    )
  }
  db.exec(`PRAGMA user_version=${LOCAL_DB_VERSION}`)
}

function isoAt(index: number) {
  return new Date(Date.UTC(2024, 0, 1) + (index % 730) * 86_400_000 + (index % 86_400) * 1_000).toISOString()
}

function seed(db: DatabaseSync, dataset: Dataset) {
  db.prepare(
    `INSERT INTO organizations(id, name, business_name, invoice_prefix, next_invoice_number, joined_at)
     VALUES (?, 'Certification Business', 'Certification Business', 'INV', ?, '2024-01-01T00:00:00.000Z')`,
  ).run(organizationId, dataset.invoices + 1)

  const insertProduct = db.prepare(
    `INSERT INTO products(
       id, organization_id, name, sku, barcode, category, supplier, warehouse, hsn_code,
       price, sale_rate, purchase_rate, stock, min_stock, batch_no, expiry_date, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertInventory = db.prepare(
    `INSERT INTO inventory_items(id, organization_id, product_id, quantity, available_quantity, reorder_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertBatch = db.prepare(
    `INSERT INTO stock_batches(id, organization_id, product_id, batch_no, expiry_date, purchase_date, quantity, purchase_rate, mrp, barcode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.exec("BEGIN IMMEDIATE")
  try {
    for (let index = 0; index < dataset.products; index += 1) {
      const id = `product-${index}`
      const stamp = isoAt(index)
      const stock = index % 17 === 0 ? 0 : index % 13 === 0 ? 3 : 500 + (index % 500)
      const rate = 25 + (index % 975)
      const batch = `BATCH-${String(index % 2_000).padStart(4, "0")}`
      const expiry = `${2026 + (index % 4)}-${String((index % 12) + 1).padStart(2, "0")}-28`
      insertProduct.run(
        id,
        organizationId,
        `Product ${String(index).padStart(6, "0")} ${index % 7 === 0 ? "Premium" : "Standard"}`,
        `SKU-${String(index).padStart(7, "0")}`,
        `890${String(index).padStart(10, "0")}`,
        `Category ${index % 40}`,
        `Supplier ${index % 75}`,
        `Warehouse ${index % 8}`,
        String(30040000 + (index % 9999)),
        rate,
        rate,
        rate * 0.72,
        stock,
        5,
        batch,
        expiry,
        stamp,
        stamp,
      )
      insertInventory.run(`inventory-${index}`, organizationId, id, stock, stock, 5, stamp, stamp)
      insertBatch.run(`batch-${index}`, organizationId, id, batch, expiry, stamp.slice(0, 10), stock, rate * 0.72, rate * 1.15, `890${String(index).padStart(10, "0")}`, stamp, stamp)
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }

  const insertCustomer = db.prepare(
    `INSERT INTO customers(
       id, organization_id, name, email, phone, gst_number, state, state_code, customer_type,
       current_balance, total_sales, last_purchase_at, is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  db.exec("BEGIN IMMEDIATE")
  try {
    for (let index = 0; index < dataset.customers; index += 1) {
      const stamp = isoAt(index)
      insertCustomer.run(
        `customer-${index}`,
        organizationId,
        `Customer ${String(index).padStart(7, "0")}`,
        `customer${index}@example.test`,
        `9${String(index).padStart(9, "0")}`,
        index % 3 === 0 ? `07ABCDE${String(index % 10_000).padStart(4, "0")}F1Z5` : null,
        index % 2 ? "Delhi" : "Maharashtra",
        index % 2 ? "07" : "27",
        index % 5 === 0 ? "wholesale" : "retail",
        index % 8 === 0 ? 1_000 + index : 0,
        10_000 + index * 3,
        stamp,
        index % 19 === 0 ? 0 : 1,
        stamp,
        stamp,
      )
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }

  const insertInvoice = db.prepare(
    `INSERT INTO sales_invoices(
       id, organization_id, customer_id, customer_name, invoice_number, invoice_date, date, due_date,
       subtotal, taxable_amount, tax_amount, tax_total, total_amount, grand_total, total,
       paid_amount, outstanding_amount, payment_status, status, payment_method, offline_client_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertItem = db.prepare(
    `INSERT INTO sales_invoice_items(
       id, organization_id, invoice_id, product_id, product_name, hsn_code, batch_no, expiry_date, unit, mrp,
       quantity, unit_price, tax_percent, line_total, gst_amount, cgst_amount, sgst_amount, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pcs', ?, ?, ?, 18, ?, ?, ?, ?, ?, ?)`,
  )
  const insertMovement = db.prepare(
    `INSERT INTO stock_movements(
       id, organization_id, product_id, product_name, batch_id, type, quantity, previous_stock, new_stock,
       reason, reference_no, reference_type, reference_id, movement_date, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, 'invoice', ?, ?, ?, ?)`,
  )
  db.exec("BEGIN IMMEDIATE")
  try {
    for (let invoiceIndex = 0; invoiceIndex < dataset.invoices; invoiceIndex += 1) {
      const invoiceId = `invoice-${invoiceIndex}`
      const customerIndex = invoiceIndex % dataset.customers
      const stamp = isoAt(invoiceIndex)
      const base = 100 + (invoiceIndex % 9_900)
      const tax = base * 0.18
      const total = base + tax
      const status = invoiceIndex % 5 === 0 ? "unpaid" : invoiceIndex % 7 === 0 ? "partial" : "paid"
      const paid = status === "paid" ? total : status === "partial" ? total / 2 : 0
      insertInvoice.run(
        invoiceId,
        organizationId,
        `customer-${customerIndex}`,
        `Customer ${String(customerIndex).padStart(7, "0")}`,
        `INV-${String(invoiceIndex + 1).padStart(7, "0")}`,
        stamp.slice(0, 10),
        stamp.slice(0, 10),
        isoAt(invoiceIndex + 14).slice(0, 10),
        base,
        base,
        tax,
        tax,
        total,
        total,
        total,
        paid,
        total - paid,
        status,
        status,
        invoiceIndex % 2 ? "cash" : "upi",
        `seed-client-${invoiceIndex}`,
        stamp,
        stamp,
      )
      for (let line = 0; line < dataset.itemsPerInvoice; line += 1) {
        const productIndex = (invoiceIndex * dataset.itemsPerInvoice + line) % dataset.products
        const rate = 50 + (productIndex % 950)
        const quantity = (line % 3) + 1
        const lineBase = rate * quantity
        const lineTax = lineBase * 0.18
        insertItem.run(
          `item-${invoiceIndex}-${line}`,
          organizationId,
          invoiceId,
          `product-${productIndex}`,
          `Product ${String(productIndex).padStart(6, "0")}`,
          String(30040000 + (productIndex % 9999)),
          `BATCH-${String(productIndex % 2_000).padStart(4, "0")}`,
          `${2026 + (productIndex % 4)}-${String((productIndex % 12) + 1).padStart(2, "0")}-28`,
          rate * 1.15,
          quantity,
          rate,
          lineBase,
          lineTax,
          lineTax / 2,
          lineTax / 2,
          stamp,
          stamp,
        )
        insertMovement.run(
          `movement-${invoiceIndex}-${line}`,
          organizationId,
          `product-${productIndex}`,
          `Product ${String(productIndex).padStart(6, "0")}`,
          `batch-${productIndex}`,
          -quantity,
          800,
          800 - quantity,
          `Invoice INV-${String(invoiceIndex + 1).padStart(7, "0")}`,
          `INV-${String(invoiceIndex + 1).padStart(7, "0")}`,
          invoiceId,
          stamp.slice(0, 10),
          stamp,
          stamp,
        )
      }
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); ANALYZE; PRAGMA optimize")
}

const productPageSql = `
  SELECT p.* FROM products p
  WHERE p.organization_id = ? AND p.deleted_at IS NULL
    AND (p.name LIKE ? COLLATE NOCASE OR p.batch_no LIKE ? COLLATE NOCASE OR p.hsn_code LIKE ? COLLATE NOCASE OR p.sku LIKE ? COLLATE NOCASE OR p.barcode LIKE ? COLLATE NOCASE)
  ORDER BY p.name COLLATE NOCASE ASC, p.id ASC LIMIT 50 OFFSET 0`
const customerPageSql = `
  WITH customer_page AS (
    SELECT c.* FROM customers c
    WHERE c.organization_id = ? AND c.deleted_at IS NULL AND (c.name LIKE ? COLLATE NOCASE OR c.phone LIKE ? COLLATE NOCASE OR c.gst_number LIKE ? COLLATE NOCASE)
    ORDER BY c.name COLLATE NOCASE ASC, c.id ASC LIMIT 50 OFFSET 0
  ), invoice_metrics AS (
    SELECT invoice.customer_id, COUNT(*) AS invoice_count, SUM(invoice.grand_total) AS invoice_revenue, MAX(invoice.created_at) AS last_purchase_at
    FROM sales_invoices invoice
    WHERE invoice.organization_id = ? AND invoice.deleted_at IS NULL AND invoice.customer_id IN (SELECT id FROM customer_page)
    GROUP BY invoice.customer_id
  )
  SELECT page.*, COALESCE(metrics.invoice_count, 0) AS invoice_count, COALESCE(metrics.invoice_revenue, page.total_sales, 0) AS total_sales
  FROM customer_page page LEFT JOIN invoice_metrics metrics ON metrics.customer_id = page.id ORDER BY page.name COLLATE NOCASE ASC`
const invoicePageSql = `
  WITH invoice_page AS (
    SELECT i.*, COALESCE(i.customer_name, c.name) AS resolved_customer_name
    FROM sales_invoices i LEFT JOIN customers c ON c.id=i.customer_id AND c.organization_id=i.organization_id
    WHERE i.organization_id=? AND i.deleted_at IS NULL AND (i.invoice_number LIKE ? COLLATE NOCASE OR COALESCE(i.customer_name, c.name) LIKE ? COLLATE NOCASE)
    ORDER BY i.invoice_date DESC, i.invoice_number DESC LIMIT 50 OFFSET 0
  ), item_metrics AS (
    SELECT item.invoice_id, COUNT(*) AS item_count, SUM(item.quantity) AS total_quantity, SUM(item.line_total) AS item_total
    FROM sales_invoice_items item
    WHERE item.organization_id=? AND item.deleted_at IS NULL AND item.invoice_id IN (SELECT id FROM invoice_page)
    GROUP BY item.invoice_id
  )
  SELECT page.*, COALESCE(metrics.item_count,0) AS item_count, COALESCE(metrics.total_quantity,0) AS total_quantity
  FROM invoice_page page LEFT JOIN item_metrics metrics ON metrics.invoice_id=page.id ORDER BY page.invoice_date DESC, page.invoice_number DESC`
const dashboardSql = `
  SELECT COUNT(*) AS invoice_count, COALESCE(SUM(grand_total),0) AS revenue,
    COALESCE(SUM(CASE WHEN payment_status='paid' THEN grand_total ELSE paid_amount END),0) AS paid_revenue,
    SUM(CASE WHEN payment_status IN ('unpaid','partial') THEN 1 ELSE 0 END) AS pending_count
  FROM sales_invoices WHERE organization_id=? AND deleted_at IS NULL`
const reportSql = `
  SELECT substr(invoice_date,1,7) AS month, COUNT(*) AS invoice_count, SUM(grand_total) AS revenue,
    SUM(tax_amount) AS tax, SUM(outstanding_amount) AS outstanding
  FROM sales_invoices WHERE organization_id=? AND deleted_at IS NULL AND invoice_date>=date('now','-24 months')
  GROUP BY substr(invoice_date,1,7) ORDER BY month`
const productFilterSql = `
  SELECT id,name,stock,category,supplier FROM products
  WHERE organization_id=? AND deleted_at IS NULL AND category=? AND supplier=? AND stock>0
  ORDER BY name COLLATE NOCASE LIMIT 50`
const customerFilterSql = `
  SELECT id,name,customer_type,gst_number FROM customers
  WHERE organization_id=? AND deleted_at IS NULL AND customer_type='wholesale'
    AND COALESCE(NULLIF(trim(gst_number),''),NULLIF(trim(tax_id),'')) IS NOT NULL
  ORDER BY name COLLATE NOCASE LIMIT 50`
const invoiceFilterSql = `
  SELECT id,invoice_number,invoice_date,payment_status,grand_total FROM sales_invoices
  WHERE organization_id=? AND deleted_at IS NULL AND payment_status='unpaid' AND invoice_date>='2025-01-01'
  ORDER BY invoice_date DESC,invoice_number DESC LIMIT 50`
const invoiceDeletionMovementsSql = `
  SELECT * FROM stock_movements
  WHERE organization_id=? AND reference_type IN ('invoice','invoice_delete') AND reference_id=? AND deleted_at IS NULL
  ORDER BY created_at,id`

function plan(db: DatabaseSync, sql: string, ...params: any[]) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row: any) => String(row.detail))
}

function planDatabase(databasePath: string, sql: string, ...params: any[]) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return plan(db, sql, ...params)
  } finally {
    db.close()
  }
}

function certifyDataset(dataset: Dataset) {
  const databasePath = path.join(root, `dataset-${dataset.name}.sqlite`)
  const db = new DatabaseSync(databasePath)
  applyMigrations(db)
  const seedStarted = performance.now()
  seed(db, dataset)
  const seedMs = round(performance.now() - seedStarted)

  const counts = db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM products WHERE organization_id=?) AS products,
      (SELECT COUNT(*) FROM customers WHERE organization_id=?) AS customers,
      (SELECT COUNT(*) FROM sales_invoices WHERE organization_id=?) AS invoices,
      (SELECT COUNT(*) FROM sales_invoice_items WHERE organization_id=?) AS invoiceItems,
      (SELECT COUNT(*) FROM stock_movements WHERE organization_id=?) AS stockMovements`,
  ).get(organizationId, organizationId, organizationId, organizationId, organizationId) as Record<string, number>
  assert.equal(counts.products, dataset.products)
  assert.equal(counts.customers, dataset.customers)
  assert.equal(counts.invoices, dataset.invoices)
  assert.equal(counts.invoiceItems, dataset.invoices * dataset.itemsPerInvoice)
  assert.equal(counts.stockMovements, counts.invoiceItems)

  const productPage = db.prepare(productPageSql)
  const customerPage = db.prepare(customerPageSql)
  const invoicePage = db.prepare(invoicePageSql)
  const dashboard = db.prepare(dashboardSql)
  const report = db.prepare(reportSql)
  const productFilter = db.prepare(productFilterSql)
  const customerFilter = db.prepare(customerFilterSql)
  const invoiceFilter = db.prepare(invoiceFilterSql)
  const term = "%0001%"
  const absentTerm = "%NO-SUCH-BEZGROW-ROW%"
  const benchmarks = {
    productSearchPage: measure(35, () => productPage.all(organizationId, term, term, term, term, term)),
    productSearchNoMatch: measure(20, () => productPage.all(organizationId, absentTerm, absentTerm, absentTerm, absentTerm, absentTerm)),
    productCombinedFilters: measure(35, () => productFilter.all(organizationId, "Category 1", "Supplier 1")),
    customerSearchPage: measure(35, () => customerPage.all(organizationId, term, term, term, organizationId)),
    customerSearchNoMatch: measure(20, () => customerPage.all(organizationId, absentTerm, absentTerm, absentTerm, organizationId)),
    customerCombinedFilters: measure(35, () => customerFilter.all(organizationId)),
    invoiceSearchPageWithItemMetrics: measure(35, () => invoicePage.all(organizationId, term, term, organizationId)),
    invoiceSearchNoMatch: measure(20, () => invoicePage.all(organizationId, absentTerm, absentTerm, organizationId)),
    invoiceCombinedFilters: measure(35, () => invoiceFilter.all(organizationId)),
    dashboardAggregate: measure(35, () => dashboard.get(organizationId)),
    twentyFourMonthReport: measure(35, () => report.all(organizationId)),
  }

  const invoiceIndex = dataset.invoices + 1
  const save = measure(20, () => {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare(
        `INSERT INTO sales_invoices(id,organization_id,customer_id,customer_name,invoice_number,invoice_date,total_amount,grand_total,total,paid_amount,outstanding_amount,payment_status,status,offline_client_id)
         VALUES ('benchmark-invoice',?,'customer-0','Customer 0000000',?,date('now'),118,118,118,0,118,'unpaid','unpaid','benchmark-client')`,
      ).run(organizationId, `INV-${String(invoiceIndex).padStart(7, "0")}`)
      db.prepare(
        `INSERT INTO sales_invoice_items(id,organization_id,invoice_id,product_id,product_name,quantity,unit_price,tax_percent,line_total,gst_amount)
         VALUES ('benchmark-item',?,'benchmark-invoice','product-1','Product 000001',1,100,18,100,18)`,
      ).run(organizationId)
      db.prepare("UPDATE products SET stock=stock-1,updated_at=datetime('now') WHERE organization_id=? AND id='product-1'").run(organizationId)
    } finally {
      db.exec("ROLLBACK")
    }
  })
  const updateStatus = measure(35, () => {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare(
        `UPDATE sales_invoices SET payment_status='paid',status='paid',paid_amount=grand_total,outstanding_amount=0,updated_at=datetime('now')
         WHERE organization_id=? AND id='invoice-100' AND deleted_at IS NULL`,
      ).run(organizationId)
    } finally {
      db.exec("ROLLBACK")
    }
  })
  const deleteInvoice = measure(20, () => {
    db.exec("BEGIN IMMEDIATE")
    try {
      const invoice = db.prepare(
        "SELECT * FROM sales_invoices WHERE organization_id=? AND id='invoice-100' AND deleted_at IS NULL LIMIT 1",
      ).get(organizationId) as Record<string, any>
      const items = db.prepare(
        "SELECT * FROM sales_invoice_items WHERE organization_id=? AND invoice_id='invoice-100' AND deleted_at IS NULL",
      ).all(organizationId) as Array<Record<string, any>>
      const movements = db.prepare(invoiceDeletionMovementsSql).all(organizationId, "invoice-100") as Array<Record<string, any>>
      assert.ok(invoice)
      assert.equal(items.length, dataset.itemsPerInvoice)
      for (const [line, item] of items.entries()) {
        const quantity = Number(item.quantity || 0)
        const movement = movements.find((candidate) => candidate.product_id === item.product_id && Number(candidate.quantity) < 0)
        db.prepare("UPDATE products SET stock=stock+?,updated_at=datetime('now') WHERE organization_id=? AND id=?").run(
          quantity,
          organizationId,
          item.product_id,
        )
        db.prepare(
          `UPDATE inventory_items SET quantity=quantity+?,available_quantity=available_quantity+?,updated_at=datetime('now')
           WHERE id=(SELECT id FROM inventory_items WHERE organization_id=? AND product_id=? AND deleted_at IS NULL LIMIT 1)`,
        ).run(quantity, quantity, organizationId, item.product_id)
        if (movement?.batch_id) {
          db.prepare("UPDATE stock_batches SET quantity=quantity+?,updated_at=datetime('now') WHERE organization_id=? AND id=?").run(
            quantity,
            organizationId,
            movement.batch_id,
          )
        }
        db.prepare(
          `INSERT INTO stock_movements(
             id,organization_id,product_id,batch_id,type,quantity,reference_type,reference_id,created_at,updated_at
           ) VALUES (?,?,?,?,? ,?,?,?,datetime('now'),datetime('now'))`,
        ).run(
          `benchmark-delete-${line}`,
          organizationId,
          item.product_id,
          movement?.batch_id || null,
          "adjustment",
          quantity,
          "invoice_delete",
          "invoice-100",
        )
      }
      db.prepare(
        "UPDATE sales_invoice_items SET deleted_at=datetime('now'),sync_status='pending_delete' WHERE organization_id=? AND invoice_id='invoice-100' AND deleted_at IS NULL",
      ).run(organizationId)
      db.prepare(
        "UPDATE sales_invoices SET deleted_at=datetime('now'),sync_status='pending_delete' WHERE organization_id=? AND id='invoice-100' AND deleted_at IS NULL",
      ).run(organizationId)
      db.prepare(
        "UPDATE customers SET total_sales=MAX(0,total_sales-?),current_balance=MAX(0,current_balance-?),updated_at=datetime('now') WHERE organization_id=? AND id=?",
      ).run(Number(invoice.grand_total || 0), Number(invoice.outstanding_amount || 0), organizationId, invoice.customer_id)
    } finally {
      db.exec("ROLLBACK")
    }
  })
  assert.throws(
    () => db.prepare("UPDATE products SET stock=stock-1 WHERE organization_id=? AND id='product-0'").run(organizationId),
    /insufficient_product_stock/,
    "The database trigger must atomically reject stock underflow.",
  )

  const rssBefore = process.memoryUsage().rss
  for (let iteration = 0; iteration < 500; iteration += 1) {
    productPage.all(organizationId, term, term, term, term, term)
    customerPage.all(organizationId, term, term, term, organizationId)
    invoicePage.all(organizationId, term, term, organizationId)
  }
  ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
  const rssGrowthMb = round(Math.max(0, process.memoryUsage().rss - rssBefore) / 1024 / 1024)
  assert.ok(rssGrowthMb < 96, `Dataset ${dataset.name} repeated list reads grew RSS by ${rssGrowthMb} MB`)

  const quickCheck = String(Object.values(db.prepare("PRAGMA quick_check").get() || {})[0])
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length
  assert.equal(quickCheck, "ok")
  assert.equal(foreignKeyViolations, 0)
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()

  const databaseStartup = measure(20, () => {
    const connection = new DatabaseSync(databasePath, { readOnly: true })
    connection.prepare("PRAGMA schema_version").get()
    connection.close()
  })

  const backupPath = path.join(root, `dataset-${dataset.name}.backup.sqlite`)
  const backupStarted = performance.now()
  copyFileSync(databasePath, backupPath)
  const backupMs = round(performance.now() - backupStarted)
  const restoredPath = path.join(root, `dataset-${dataset.name}.restored.sqlite`)
  const restoreStarted = performance.now()
  copyFileSync(backupPath, restoredPath)
  const restored = new DatabaseSync(restoredPath, { readOnly: true })
  const restoreQuickCheck = String(Object.values(restored.prepare("PRAGMA quick_check").get() || {})[0])
  const restoredCounts = restored.prepare("SELECT COUNT(*) AS invoices FROM sales_invoices WHERE organization_id=?").get(organizationId) as { invoices: number }
  restored.close()
  const restoreMs = round(performance.now() - restoreStarted)
  assert.equal(restoreQuickCheck, "ok")
  assert.equal(restoredCounts.invoices, dataset.invoices)

  return {
    dataset,
    counts,
    databaseBytes: statSync(databasePath).size,
    seedMs,
    benchmarks: {
      ...benchmarks,
      invoiceAtomicRollback: save,
      invoiceStatusRollback: updateStatus,
      invoiceDeleteRestoreRollback: deleteInvoice,
      databaseStartup,
    },
    soak: { cycles: 500, rssGrowthMb },
    integrity: { quickCheck, foreignKeyViolations },
    backupRestore: { backupMs, restoreMs, restoredInvoices: restoredCounts.invoices, quickCheck: restoreQuickCheck },
    queryPlans: {
      productSearchPage: planDatabase(databasePath, productPageSql, organizationId, term, term, term, term, term),
      invoiceSearchPage: planDatabase(databasePath, invoicePageSql, organizationId, term, term, organizationId),
      invoiceDeletionMovements: planDatabase(databasePath, invoiceDeletionMovementsSql, organizationId, "invoice-100"),
    },
  }
}

try {
  const started = performance.now()
  const results = datasets.map(certifyDataset)
  for (const result of results) {
    for (const [name, sample] of Object.entries(result.benchmarks)) {
      assert.ok(sample.p95Ms < 2_000, `${result.dataset.name}/${name} p95 exceeded the 2-second usability ceiling: ${sample.p95Ms} ms`)
    }
  }
  const output = {
    generatedAt: new Date().toISOString(),
    schemaVersion: LOCAL_DB_VERSION,
    isolatedRoot: root,
    durationMs: round(performance.now() - started),
    results,
  }
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(JSON.stringify(output, null, 2))
  console.log(`large-scale-certification-ok result=${outputPath}`)
} finally {
  if (!keepFixtures && existsSync(root) && !outputPath.startsWith(`${root}${path.sep}`)) rmSync(root, { recursive: true, force: true })
}
