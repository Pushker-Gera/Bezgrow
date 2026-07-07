"use client"

import { getLocalDatabaseService } from "@/lib/offline/local/service"

function validationId(prefix: string) {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

export async function validateLocalDatabaseFoundation() {
  const service = getLocalDatabaseService()
  const integrity = await service.integrityReport()
  const rollbackProbeId = validationId("rollback-probe")

  await service
    .transaction(async (db) => {
      await db.execute("INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))", [
        rollbackProbeId,
        "Rollback Probe",
      ])
      throw new Error("Rollback probe")
    })
    .catch(() => undefined)

  const rollbackRows = await service.select<{ id: string }>("SELECT id FROM organizations WHERE id = ? LIMIT 1", [rollbackProbeId])
  const invoiceNumberRows = await service.select<{ missing_next_number: number }>(
    "SELECT COUNT(*) AS missing_next_number FROM organizations WHERE next_invoice_number IS NULL OR next_invoice_number < 1"
  )
  const stockReferenceRows = await service.select<{ broken_stock_references: number }>(
    `SELECT COUNT(*) AS broken_stock_references
     FROM stock_movements sm
     LEFT JOIN products p ON p.id = sm.product_id
     WHERE sm.product_id IS NOT NULL AND p.id IS NULL`
  )
  const ledgerRows = await service.select<{ organization_id: string; difference: number }>(
    `SELECT organization_id, ROUND(SUM(debit) - SUM(credit), 2) AS difference
     FROM ledger_entries
     GROUP BY organization_id
     HAVING ABS(ROUND(SUM(debit) - SUM(credit), 2)) > 0.01`
  )

  return {
    integrity,
    rollbackOk: rollbackRows.length === 0,
    invoiceNumberingOk: Number(invoiceNumberRows[0]?.missing_next_number || 0) === 0,
    stockReferencesOk: Number(stockReferenceRows[0]?.broken_stock_references || 0) === 0,
    ledgerBalanced: ledgerRows.length === 0,
    ledgerImbalances: ledgerRows,
  }
}
