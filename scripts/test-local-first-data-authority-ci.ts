import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-authority-fixture-"))
const databasePath = path.join(directory, "authority-source.db")
const database = new DatabaseSync(databasePath)

try {
  database.exec("PRAGMA foreign_keys = ON")
  for (const migration of localMigrations) {
    database.exec("BEGIN IMMEDIATE")
    try {
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
      database.prepare("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(migration.version, migration.name)
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }
  database.prepare("INSERT INTO organizations (id, name, business_name, sync_status) VALUES (?, ?, ?, ?)")
    .run("ci-local-business", "CI Local Business", "CI Local Business", "local")
  const version = database.prepare("PRAGMA user_version").get()?.user_version
  if (version !== LOCAL_DB_VERSION) throw new Error(`Fixture schema version ${version} does not match ${LOCAL_DB_VERSION}.`)
  database.close()

  const result = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "scripts/test-local-first-data-authority.mjs",
    `--database=${databasePath}`,
  ], { cwd: process.cwd(), encoding: "utf8", stdio: "inherit" })
  if (result.status !== 0) process.exitCode = result.status ?? 1
} finally {
  try { database.close() } catch {}
  rmSync(directory, { recursive: true, force: true })
}
