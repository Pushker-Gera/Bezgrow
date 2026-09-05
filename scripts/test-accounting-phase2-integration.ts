import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"

type SqlValue = string | number | null
type StatementPayload = { query: string; bindValues?: SqlValue[]; ignoreDuplicateColumn?: boolean }

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-phase2-integration-"))
const databasePath = path.join(directory, "business.db")
const db = new DatabaseSync(databasePath)

Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true })
Object.defineProperty(globalThis, "location", { value: { hostname: "127.0.0.1", port: "43123" }, configurable: true })
Object.assign(globalThis, { __BEZGROW_DESKTOP__: true, __BEZGROW_RUNTIME__: "tauri-packaged" })

function payloadStatement(payload: unknown) {
  return (payload as { statement: StatementPayload }).statement
}

function run(statement: StatementPayload) {
  const values = statement.bindValues || []
  if (values.length) return Number(db.prepare(statement.query).run(...values).changes)
  db.exec(statement.query)
  return 0
}

mockIPC((command, payload) => {
  if (command === "desktop_startup_log") return null
  if (command === "desktop_database_backup") return null
  if (command === "desktop_database_diagnostics") return {
    applicationVersion: "0.3.0-test",
    appConfigDir: directory,
    appDataDir: directory,
    databasePath,
    deviceIdSource: "test",
    licenseStateSource: "test",
    legacyMigrationOccurred: false,
    legacyMigrationSource: null,
    parentExists: true,
    parentCreated: false,
    parentWritable: true,
    databaseExists: true,
    databaseBytes: 0,
  }
  if (command === "desktop_execute") return run(payloadStatement(payload))
  if (command === "desktop_select") {
    const statement = payloadStatement(payload)
    return db.prepare(statement.query).all(...(statement.bindValues || []))
  }
  if (command === "desktop_execute_transaction") {
    const statements = (payload as { statements: StatementPayload[] }).statements
    db.exec("BEGIN IMMEDIATE")
    db.exec("PRAGMA defer_foreign_keys=ON")
    try {
      let rowsAffected = 0
      for (const statement of statements) {
        try {
          rowsAffected += run(statement)
        } catch (error) {
          if (statement.ignoreDuplicateColumn && /duplicate column name/i.test(String(error))) continue
          throw new Error(`${String(error)}\nSQL: ${statement.query.slice(0, 500)}`, { cause: error })
        }
      }
      db.exec("COMMIT")
      return { statements: statements.length, rowsAffected }
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
  throw new Error(`Unexpected desktop command in Phase 2 integration test: ${command}`)
})

async function main() {
try {
  const [{ getLocalDatabaseService }, { initializeAccounting }, phase2, expenses] = await Promise.all([
    import("../lib/offline/local/service"),
    import("../lib/offline/local/accounting"),
    import("../lib/offline/local/accounting-phase2"),
    import("../lib/offline/local/accounting"),
  ])

  await getLocalDatabaseService().ensureReady()
  db.exec("INSERT INTO organizations(id,name,state,gst_number,created_at,updated_at) VALUES ('org:integration','Integration Business','MH','27AAPFU0939F1ZV',datetime('now'),datetime('now'))")
  db.exec("INSERT INTO financial_years(id,organization_id,label,start_date,end_date,start_month,status,is_active,created_at) VALUES ('fy:org:integration:2026:4','org:integration','FY 2026-27','2026-04-01','2027-03-31',4,'OPEN',1,datetime('now'))")
  db.exec("INSERT INTO warehouses(id,organization_id,name,code) VALUES ('warehouse:main','org:integration','Main Warehouse','MAIN')")
  db.exec("INSERT INTO products(id,organization_id,name,sku,hsn_code,unit,warehouse_id,stock,purchase_rate,gst,created_at,updated_at) VALUES ('product:medicine','org:integration','Batch Medicine','MED-1','300490','box','warehouse:main',0,100,18,datetime('now'),datetime('now'))")
  db.exec("INSERT INTO customers(id,organization_id,name,state,current_balance,created_at,updated_at) VALUES ('customer:one','org:integration','Customer One','MH',0,datetime('now'),datetime('now'))")

  await initializeAccounting("org:integration", "2026-09-05")
  const supplier = await phase2.saveSupplier("org:integration", {
    name: "Supplier One",
    state: "MH",
    gstin: "27AAPFU0939F1ZV",
    payment_terms: "30 days",
    credit_days: 30,
    opening_balance: 20,
    opening_balance_type: "advance",
    opening_date: "2026-09-05",
  })
  const cash = db.prepare("SELECT id FROM chart_of_accounts WHERE organization_id='org:integration' AND system_role='CASH'").get() as { id: string }
  const expenseAccount = db.prepare("SELECT id FROM chart_of_accounts WHERE organization_id='org:integration' AND system_role='RENT_EXPENSE'").get() as { id: string }
  const openingAdvance = db.prepare("SELECT id FROM party_advances WHERE organization_id='org:integration' AND party_type='supplier' AND party_id=? AND source_type='SUPPLIER_OPENING'").get(supplier.supplier_id) as { id: string }
  assert.ok(openingAdvance.id)

  const openingPayableSupplier = await phase2.saveSupplier("org:integration", {
    name: "Opening Payable Supplier",
    state: "MH",
    opening_balance: 50,
    opening_balance_type: "payable",
    opening_date: "2026-09-05",
  })
  const openingReference = await phase2.phaseTwoReferenceData("org:integration", "fy:org:integration:2026:4")
  const openingDocument = openingReference.purchases.find((row) => row.document_type === "supplier_opening" && row.supplier_id === openingPayableSupplier.supplier_id)
  assert.equal(Number(openingDocument?.outstanding_minor || 0), 5_000)
  await phase2.createPartyPayment("org:integration", {
    party_id: openingPayableSupplier.supplier_id,
    payment_date: "2026-09-06",
    amount: 50,
    payment_account_id: cash.id,
    allocations: [{ document_id: openingDocument?.id, allocation_amount: 50 }],
  }, "supplier")
  assert.equal(Number((db.prepare("SELECT current_balance FROM suppliers WHERE id=?").get(openingPayableSupplier.supplier_id) as { current_balance: number }).current_balance), 0)
  assert.equal(String((db.prepare("SELECT document_type FROM payment_allocations WHERE document_id=?").get(openingDocument?.id) as { document_type: string }).document_type), "supplier_opening")

  const purchase = await phase2.createPurchase("org:integration", {
    supplier_id: supplier.supplier_id,
    supplier_invoice_number: "SUP-2026-001",
    supplier_invoice_date: "2026-09-05",
    purchase_date: "2026-09-05",
    due_date: "2026-10-05",
    place_of_supply: "MH",
    supply_type: "INTRA_STATE",
    tax_category: "TAXABLE",
    itc_status: "ELIGIBLE",
    idempotency_key: "integration-purchase-1",
    items: [{
      product_id: "product:medicine",
      product_name: "Batch Medicine",
      hsn_code: "300490",
      quantity: 2,
      unit: "box",
      unit_cost: 100,
      gst_rate: 18,
      purchase_classification: "INVENTORY",
      warehouse_id: "warehouse:main",
      batch_no: "BATCH-001",
      expiry_date: "2028-03-31",
    }],
  })
  assert.equal("outstanding_minor" in purchase ? purchase.outstanding_minor : null, 23_600)
  assert.equal(Number((db.prepare("SELECT stock FROM products WHERE id='product:medicine'").get() as { stock: number }).stock), 2)
  assert.equal(Number((db.prepare("SELECT quantity FROM stock_batches WHERE source_id=?").get(purchase.purchase_id) as { quantity: number }).quantity), 2)
  assert.equal(Number((db.prepare("SELECT total_debit_minor-total_credit_minor balance FROM accounting_vouchers WHERE id=?").get(purchase.accounting_voucher_id) as { balance: number }).balance), 0)

  const payment = await phase2.createPartyPayment("org:integration", {
    party_id: supplier.supplier_id,
    payment_date: "2026-09-06",
    amount: 100,
    payment_account_id: cash.id,
    reference_no: "UTR-001",
    idempotency_key: "integration-payment-1",
    allocations: [{ document_id: purchase.purchase_id, allocation_amount: 100 }],
  }, "supplier")
  assert.equal(payment.allocated_minor, 10_000)
  assert.equal(Number((db.prepare("SELECT outstanding_minor FROM purchase_invoices WHERE id=?").get(purchase.purchase_id) as { outstanding_minor: number }).outstanding_minor), 13_600)

  const purchaseReturn = await phase2.createPurchaseReturn("org:integration", {
    supplier_id: supplier.supplier_id,
    purchase_invoice_id: purchase.purchase_id,
    supplier_invoice_number: "DN-2026-001",
    purchase_date: "2026-09-07",
    place_of_supply: "MH",
    supply_type: "INTRA_STATE",
    tax_category: "TAXABLE",
    itc_status: "ELIGIBLE",
    idempotency_key: "integration-return-1",
    items: [{ product_id: "product:medicine", product_name: "Batch Medicine", quantity: 1, unit_cost: 100, gst_rate: 18, purchase_classification: "INVENTORY", warehouse_id: "warehouse:main" }],
  })
  assert.equal(purchaseReturn.payable_reduction_minor, 11_800)
  assert.equal(Number((db.prepare("SELECT stock FROM products WHERE id='product:medicine'").get() as { stock: number }).stock), 1)
  assert.equal(Number((db.prepare("SELECT outstanding_minor FROM purchase_invoices WHERE id=?").get(purchase.purchase_id) as { outstanding_minor: number }).outstanding_minor), 1_800)
  await phase2.applyPartyAdvance("org:integration", {
    advance_id: openingAdvance.id,
    document_id: purchase.purchase_id,
    allocation_date: "2026-09-07",
    amount: 18,
  }, "supplier")
  assert.equal(Number((db.prepare("SELECT current_balance FROM suppliers WHERE id=?").get(supplier.supplier_id) as { current_balance: number }).current_balance), 0)

  const batch = db.prepare("SELECT id FROM stock_batches WHERE source_id=?").get(purchase.purchase_id) as { id: string }
  db.exec(`INSERT INTO sales_invoices (
      id,organization_id,customer_id,customer_name,invoice_number,invoice_type,invoice_date,due_date,
      subtotal,taxable_amount,tax_amount,tax_total,total_amount,grand_total,total,paid_amount,outstanding_amount,
      payment_status,status,financial_year_id,taxable_minor,cgst_minor,sgst_minor,igst_minor,grand_total_minor,
      paid_minor,outstanding_minor,place_of_supply,customer_gstin,supply_type,transaction_type,tax_category,
      created_at,updated_at
    ) VALUES (
      'invoice:credit-source','org:integration','customer:one','Customer One','INV-000001','standard','2026-09-08','2026-10-08',
      100,100,18,18,118,118,118,0,118,'unpaid','unpaid','fy:org:integration:2026:4',10000,900,900,0,11800,
      0,11800,'MH','27AAPFU0939F1ZV','INTRA_STATE','B2B','TAXABLE',datetime('now'),datetime('now')
    )`)
  db.exec(`INSERT INTO sales_invoice_items (
      id,organization_id,invoice_id,product_id,product_name,description,hsn_code,quantity,unit_price,tax_percent,
      line_total,gst_amount,cgst_amount,sgst_amount,igst_amount,cost_rate_minor,cost_amount_minor,cost_status,
      taxable_minor,cgst_minor,sgst_minor,igst_minor,gst_rate_basis_points,created_at,updated_at
    ) VALUES (
      'invoice-item:credit-source','org:integration','invoice:credit-source','product:medicine','Batch Medicine',
      'Batch Medicine','300490',1,100,18,118,18,9,9,0,10000,10000,'RECORDED',10000,900,900,0,1800,
      datetime('now'),datetime('now')
    )`)
  db.prepare("UPDATE products SET stock=stock-1 WHERE id='product:medicine'").run()
  db.prepare("UPDATE stock_batches SET quantity=quantity-1 WHERE id=?").run(batch.id)
  db.prepare("UPDATE inventory_items SET quantity=quantity-1,available_quantity=available_quantity-1 WHERE batch_id=?").run(batch.id)
  db.prepare(`INSERT INTO stock_movements (
      id,organization_id,product_id,product_name,warehouse_id,batch_id,type,quantity,previous_stock,new_stock,
      reason,reference_no,reference_type,reference_id,movement_date,financial_year_id,unit_cost_minor,
      total_cost_minor,cost_status,created_at,updated_at
    ) VALUES (
      'movement:credit-source','org:integration','product:medicine','Batch Medicine','warehouse:main',?,'sale',-1,1,0,
      'Sale','INV-000001','invoice','invoice:credit-source','2026-09-08','fy:org:integration:2026:4',10000,10000,
      'RECORDED',datetime('now'),datetime('now')
    )`).run(batch.id)
  db.exec("UPDATE customers SET current_balance=118 WHERE id='customer:one'")

  const receipt = await phase2.createPartyPayment("org:integration", {
    party_id: "customer:one",
    payment_date: "2026-09-08",
    amount: 150,
    payment_account_id: cash.id,
    reference_no: "CUSTOMER-UPI-1",
    idempotency_key: "integration-receipt-1",
    allocations: [{ document_id: "invoice:credit-source", allocation_amount: 100 }],
  }, "customer")
  assert.equal(receipt.advance_minor, 5_000)
  assert.equal(Number((db.prepare("SELECT current_balance FROM customers WHERE id='customer:one'").get() as { current_balance: number }).current_balance), 18)
  const customerAdvance = db.prepare("SELECT id FROM party_advances WHERE payment_id=?").get(receipt.payment_id) as { id: string }
  await phase2.applyPartyAdvance("org:integration", {
    advance_id: customerAdvance.id,
    document_id: "invoice:credit-source",
    allocation_date: "2026-09-09",
    amount: 18,
  }, "customer")
  assert.equal(Number((db.prepare("SELECT current_balance FROM customers WHERE id='customer:one'").get() as { current_balance: number }).current_balance), 0)

  const creditNote = await phase2.createSalesCreditNote("org:integration", {
    invoice_id: "invoice:credit-source",
    note_number: "CN-000001",
    note_date: "2026-09-10",
    reason: "Customer return",
    items: [{ invoice_item_id: "invoice-item:credit-source", product_id: "product:medicine", quantity: 1 }],
  })
  assert.equal(creditNote.customer_advance_minor, 11_800)
  assert.equal(Number((db.prepare("SELECT stock FROM products WHERE id='product:medicine'").get() as { stock: number }).stock), 1)
  assert.equal(Number((db.prepare("SELECT total_debit_minor-total_credit_minor balance FROM accounting_vouchers WHERE id=?").get(creditNote.accounting_voucher_id) as { balance: number }).balance), 0)

  await expenses.createAccountingExpense({
    organizationId: "org:integration",
    expenseDate: "2026-09-08",
    description: "Office rent",
    vendorName: "Landlord",
    expenseAccountId: expenseAccount.id,
    paymentAccountId: cash.id,
    amount: 118,
    taxableValue: 100,
    cgst: 9,
    sgst: 9,
    gstRate: 18,
    partyGstin: "27AAPFU0939F1ZV",
    supplierInvoiceNumber: "RENT-SEP-26",
    hsnCode: "997212",
    placeOfSupply: "MH",
    supplyType: "INTRA_STATE",
    taxCategory: "TAXABLE",
    itcStatus: "ELIGIBLE",
  })

  const bank = await phase2.saveBankAccount("org:integration", {
    display_name: "Operating Bank",
    bank_name: "Test Bank",
    account_number: "1234567890",
    account_type: "CURRENT",
    opening_balance: 1_000,
    opening_date: "2026-09-05",
  })
  assert.equal(bank.masked_identifier.endsWith("7890"), true)

  const gstOverview = await phase2.phaseTwoAccountingReport({ organizationId: "org:integration", financialYearId: "fy:org:integration:2026:4", report: "gst-overview" })
  assert.equal(gstOverview.inputCgstMinor, 1_800)
  assert.equal(gstOverview.inputSgstMinor, 1_800)
  assert.equal(gstOverview.netGstMinor, -3_600)

  const purchaseRegister = await phase2.phaseTwoAccountingReport({ organizationId: "org:integration", financialYearId: "fy:org:integration:2026:4", report: "gst-purchase-register", limit: 2 })
  assert.equal(purchaseRegister.total, 3)
  assert.equal(purchaseRegister.rows.length, 2)
  const hsn = await phase2.phaseTwoAccountingReport({ organizationId: "org:integration", financialYearId: "fy:org:integration:2026:4", report: "hsn-summary" })
  assert.equal((hsn.rows || []).some((row) => row.source === "EXPENSE" && row.hsn_code === "997212"), true)
  const validation = await phase2.phaseTwoAccountingReport({ organizationId: "org:integration", financialYearId: "fy:org:integration:2026:4", report: "gst-validation" })
  assert.equal((validation.rows || []).some((row) => String(row.warning).includes("Tax amount does not match")), false)

  const bankBook = await phase2.phaseTwoAccountingReport({ organizationId: "org:integration", financialYearId: "fy:org:integration:2026:4", report: "bank-book", accountId: bank.account_id })
  assert.equal((bankBook.rows || []).length, 1)
  const bankEntry = (bankBook.rows || [])[0]
  assert.ok(bankEntry)
  const reconciliation = await phase2.updateBankReconciliation("org:integration", {
    bank_account_id: bank.bank_account_id,
    voucher_entry_id: bankEntry.id,
    status: "CLEARED",
    cleared_date: "2026-09-09",
    bank_reference: "BANK-REF-1",
  })
  assert.equal(reconciliation.status, "CLEARED")

  const attachment = await phase2.savePurchaseAttachment("org:integration", {
    purchase_id: purchase.purchase_id,
    relative_path: "business-assets/purchase-attachments/integration.pdf",
    file_name: "integration.pdf",
    media_type: "application/pdf",
    size_bytes: 128,
    sha256: "a".repeat(64),
  })
  assert.equal(Boolean(attachment.attachment_id), true)

  const periodLock = await phase2.lockAccountingPeriod("org:integration", {
    locked_through: "2026-09-30",
    confirmation: "LOCK BOOKS",
    reason: "Monthly GST close",
  })
  await assert.rejects(
    () => phase2.createPartyPayment("org:integration", {
      party_id: supplier.supplier_id,
      payment_date: "2026-09-15",
      amount: 1,
      payment_account_id: cash.id,
    }, "supplier"),
    /locked through/
  )
  await phase2.unlockAccountingPeriod("org:integration", {
    lock_id: periodLock.lock_id,
    confirmation: "UNLOCK BOOKS",
    reason: "Owner-approved correction window",
  })

  const trialBalance = await expenses.accountingReport({
    organizationId: "org:integration",
    financialYearId: "fy:org:integration:2026:4",
    report: "trial-balance",
  })
  assert.equal(trialBalance.totalDebitMinor, trialBalance.totalCreditMinor)
  assert.equal(trialBalance.integrity?.ok, true)

  const integrity = await getLocalDatabaseService().integrityReport()
  assert.deepEqual(integrity, { quickCheck: "ok", foreignKeyViolations: 0, ok: true })
  console.log(JSON.stringify({
    status: "ok",
    purchaseAtomic: true,
    inventoryReceipt: true,
    supplierAllocation: true,
    customerAllocationAndAdvance: true,
    debitNote: true,
    salesCreditNote: true,
    expenseGst: true,
    bankOpening: true,
    reconciliation: true,
    gstReports: true,
    attachmentMetadata: true,
    periodLock: true,
    trialBalance: true,
  }))
} finally {
  clearMocks()
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
