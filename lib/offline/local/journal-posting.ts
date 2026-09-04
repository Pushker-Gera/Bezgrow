"use client"

import { minorToMoney } from "@/lib/accounting/money"
import { validateJournal, type JournalDraft, type ValidatedJournal } from "@/lib/accounting/journal"
import type { SqlExecutor } from "@/lib/offline/local/service"

function nowIso() {
  return new Date().toISOString()
}

export async function appendJournal(tx: SqlExecutor, draftInput: JournalDraft | ValidatedJournal) {
  const draft = validateJournal(draftInput)
  const timestamp = nowIso()
  await tx.execute(
    `INSERT INTO accounting_vouchers (
       id, organization_id, voucher_number, voucher_type, voucher_date, reference_no, narration,
       total_debit, total_credit, total_debit_minor, total_credit_minor, status, financial_year_id,
       source_type, source_id, reversal_of_voucher_id, is_system_generated, accounting_version,
       created_by, sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 1, ?, 'local', ?, ?)`,
    [
      draft.id, draft.organizationId, draft.voucherNumber, draft.voucherType, draft.voucherDate,
      draft.referenceNo || null, draft.narration, minorToMoney(draft.totalDebitMinor), minorToMoney(draft.totalCreditMinor),
      draft.totalDebitMinor, draft.totalCreditMinor, draft.financialYearId, draft.sourceType, draft.sourceId,
      draft.reversalOfVoucherId || null, draft.systemGenerated ? 1 : 0, draft.createdBy || null, timestamp, timestamp,
    ]
  )
  for (const [index, item] of draft.lines.entries()) {
    await tx.execute(
      `INSERT INTO accounting_voucher_entries (
         id, organization_id, voucher_id, account_id, account_type, party_type, party_id, line_no,
         debit, credit, debit_minor, credit_minor, customer_id, supplier_id, description, reference,
         sync_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
      [
        `${draft.id}:line:${index + 1}`, draft.organizationId, draft.id, item.accountId, item.accountType,
        item.partyType || null, item.partyId || null, index + 1, minorToMoney(item.debitMinor), minorToMoney(item.creditMinor),
        item.debitMinor, item.creditMinor, item.customerId || null, item.supplierId || null,
        item.description || null, item.reference || null, timestamp, timestamp,
      ]
    )
  }
  await tx.execute(
    "UPDATE accounting_vouchers SET status = 'posted', finalized_at = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'draft'",
    [timestamp, timestamp, draft.organizationId, draft.id]
  )
  if (draft.reversalOfVoucherId) {
    await tx.execute(
      "UPDATE accounting_vouchers SET reversed_by_voucher_id = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND reversed_by_voucher_id IS NULL",
      [draft.id, timestamp, draft.organizationId, draft.reversalOfVoucherId]
    )
  }
  return draft
}
