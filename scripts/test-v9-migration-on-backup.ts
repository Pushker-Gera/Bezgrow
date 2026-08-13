import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
// @ts-expect-error node:sqlite ships with Node 22; the project keeps Node 20 declarations for Next compatibility.
import { DatabaseSync } from "node:sqlite"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const source = process.env.BEZGROW_MIGRATION_SOURCE_DB?.trim()
if (!source) throw new Error("Set BEZGROW_MIGRATION_SOURCE_DB to a protected pre-refinement SQLite backup.")

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-v9-migration-"))
const copy = path.join(directory, "migration-test.db")
copyFileSync(source, copy)
const database = new DatabaseSync(copy)
const protectedTables = [
  "organizations",
  "products",
  "customers",
  "sales_invoices",
  "sales_invoice_items",
  "stock_movements",
  "orders",
  "order_items",
  "license_state",
]

function count(table: string) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0)
}

try {
  database.exec("PRAGMA foreign_keys = ON")
  const before = Object.fromEntries(protectedTables.map((table) => [table, count(table)]))
  const current = Number(database.prepare("PRAGMA user_version").get()?.user_version || 0)
  const pending = localMigrations.filter((migration) => migration.version > current)
  if (!pending.some((migration) => migration.version === 9)) throw new Error(`Expected version 9 to be pending from backup version ${current}.`)

  database.exec("BEGIN IMMEDIATE")
  try {
    for (const migration of pending) {
      for (const statement of migration.sql) {
        try {
          database.exec(statement)
        } catch (error) {
          const duplicateColumn = /^\s*ALTER\s+TABLE/i.test(statement)
            && error instanceof Error
            && /duplicate column name/i.test(error.message)
          if (!duplicateColumn) throw error
        }
      }
      database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, datetime('now'))")
        .run(migration.version, migration.name)
    }
    database.exec(`PRAGMA user_version = ${LOCAL_DB_VERSION}`)
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }

  const after = Object.fromEntries(protectedTables.map((table) => [table, count(table)]))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("A protected table row count changed during the migration test.")
  const columns = database.prepare("PRAGMA table_info(sales_invoice_items)").all().map((row: { name?: string }) => row.name)
  for (const column of ["batch_no", "expiry_date", "unit", "mrp"]) {
    if (!columns.includes(column)) throw new Error(`Missing migrated invoice-item column ${column}.`)
  }
  const quickCheck = String(database.prepare("PRAGMA quick_check").get()?.quick_check || "")
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all()
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version || 0)
  if (quickCheck !== "ok" || foreignKeys.length !== 0 || version !== LOCAL_DB_VERSION) {
    throw new Error(`Migration validation failed: version=${version} quick_check=${quickCheck} foreign_keys=${foreignKeys.length}`)
  }
  console.log(`v9-migration-backup-ok from=${current} to=${version} protected_tables=${protectedTables.length} quick_check=${quickCheck} foreign_keys=${foreignKeys.length}`)
} finally {
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
