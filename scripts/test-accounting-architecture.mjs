import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const files = [
  "lib/accounting/money.ts", "lib/accounting/journal.ts", "lib/offline/local/accounting.ts",
  "lib/offline/local/journal-posting.ts", "components/accounting/AccountingWorkspace.tsx",
]
const source = files.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n")
assert.doesNotMatch(source, /@supabase|supabase-js|from\(["'][^"']+["']\)/i, "Accounting source must not depend on Supabase or a cloud table client")
assert.match(source, /debit_minor/)
assert.match(source, /credit_minor/)
assert.match(source, /reversalOfVoucherId|reversal_of_voucher_id/)
assert.match(source, /CONTROLLED_OPENING/)
assert.match(readFileSync(path.join(root, "lib/offline/local/schema.ts"), "utf8"), /posted_journal_is_immutable/)
assert.match(readFileSync(path.join(root, "app/dashboard/layout.tsx"), "utf8"), /\/dashboard\/accounting/)
console.log(JSON.stringify({ status: "ok", localAuthority: "SQLite", cloudAccountingImports: 0, accountingNavigation: true }))
