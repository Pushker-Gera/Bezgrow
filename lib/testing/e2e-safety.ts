const DEFAULT_TEST_BUSINESS_PREFIX = "E2E-TEST-"

type MaybeEnv = Record<string, string | undefined>

export type TestOwnedRecord = {
  table: string
  id: string
  testRunId: string
}

export type DestructiveTestGuardInput = {
  operation: string
  targetBusinessName: string
  targetBusinessId?: string
  primaryProductionBusinessName?: string
  primaryProductionBusinessId?: string
  adminAccountEmail?: string
  targetAccountEmail?: string
  testRunId: string
  plannedRecords: TestOwnedRecord[]
  env?: MaybeEnv
}

export type CleanupQueryGuardInput = {
  sql: string
  bindValues?: unknown[]
  testRunId: string
}

function envValue(env: MaybeEnv | undefined, key: string) {
  return env?.[key] ?? (typeof process !== "undefined" ? process.env[key] : undefined)
}

function compactTimestamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "")
}

function safeRandomSuffix() {
  const cryptoValue = globalThis.crypto
  if (cryptoValue && "randomUUID" in cryptoValue) return cryptoValue.randomUUID().slice(0, 8)
  return Math.random().toString(36).slice(2, 10)
}

function normalize(value: string | undefined) {
  return (value || "").trim().toLowerCase()
}

function isExplicitE2eMode(value: string | undefined) {
  return ["1", "true", "yes", "e2e", "test"].includes(normalize(value))
}

export function createE2eTestRunId(date = new Date()) {
  return `${DEFAULT_TEST_BUSINESS_PREFIX}${compactTimestamp(date)}-${safeRandomSuffix()}`
}

export function testBusinessName(name: string, testRunId: string) {
  const suffix = name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return `${testRunId}${suffix ? `-${suffix}` : ""}`
}

export function markTestOwnedRecord<T extends Record<string, unknown>>(record: T, testRunId: string): T & { e2e_test_run_id: string } {
  return {
    ...record,
    e2e_test_run_id: testRunId,
  }
}

export function assertDestructiveE2eAllowed(input: DestructiveTestGuardInput) {
  const env = input.env
  const errors: string[] = []
  const nodeEnv = envValue(env, "NODE_ENV")
  const e2eMode = envValue(env, "BEZGROW_E2E_MODE")
  const allowed = envValue(env, "BEZGROW_E2E_ALLOW_DESTRUCTIVE_TESTS")
  const expectedPrefix = envValue(env, "BEZGROW_E2E_TEST_BUSINESS_PREFIX") || DEFAULT_TEST_BUSINESS_PREFIX

  if (nodeEnv !== "test" && !isExplicitE2eMode(e2eMode)) {
    errors.push("NODE_ENV must be test or BEZGROW_E2E_MODE must explicitly enable E2E mode.")
  }

  if (allowed !== "true") {
    errors.push("BEZGROW_E2E_ALLOW_DESTRUCTIVE_TESTS must equal true.")
  }

  if (!input.targetBusinessName.startsWith(expectedPrefix)) {
    errors.push(`Target business name must start with ${expectedPrefix}.`)
  }

  if (!input.primaryProductionBusinessName && !input.primaryProductionBusinessId) {
    errors.push("Primary production business identity must be provided before destructive cleanup.")
  }

  if (
    input.primaryProductionBusinessName &&
    normalize(input.primaryProductionBusinessName) === normalize(input.targetBusinessName)
  ) {
    errors.push("Target business matches the primary production business name.")
  }

  if (input.primaryProductionBusinessId && input.primaryProductionBusinessId === input.targetBusinessId) {
    errors.push("Target business matches the primary production business id.")
  }

  if (input.adminAccountEmail && normalize(input.adminAccountEmail) === normalize(input.targetAccountEmail)) {
    errors.push("The admin account itself must never be deleted.")
  }

  if (!input.testRunId.startsWith(expectedPrefix)) {
    errors.push(`Test run id must start with ${expectedPrefix}.`)
  }

  if (!input.plannedRecords.length) {
    errors.push("Cleanup plan must list exactly which test-owned records will be cleaned.")
  }

  const unownedRecords = input.plannedRecords.filter((record) => record.testRunId !== input.testRunId)
  if (unownedRecords.length) {
    errors.push("Cleanup can only remove records created by the current test-run id.")
  }

  if (!input.operation.trim()) {
    errors.push("Destructive operation must include a clear operation name.")
  }

  if (errors.length) {
    throw new Error(`Unsafe destructive E2E operation blocked: ${errors.join(" ")}`)
  }

  return {
    operation: input.operation,
    targetBusinessName: input.targetBusinessName,
    testRunId: input.testRunId,
    plannedRecords: input.plannedRecords.map((record) => ({ table: record.table, id: record.id })),
  }
}

export function assertScopedCleanupQuery(input: CleanupQueryGuardInput) {
  const sql = input.sql.trim()
  const normalizedSql = sql.replace(/\s+/g, " ").toLowerCase()
  const bindText = JSON.stringify(input.bindValues || [])

  if (/\btruncate\b|\bdrop\s+table\b/.test(normalizedSql)) {
    throw new Error("Unsafe cleanup blocked: truncate and drop table are forbidden.")
  }

  if (/^delete\s+from\s+\S+$/i.test(normalizedSql) || (/^delete\s+from/i.test(normalizedSql) && !/\bwhere\b/i.test(normalizedSql))) {
    throw new Error("Unsafe cleanup blocked: delete statements must be scoped with a WHERE clause.")
  }

  if (/^delete\s+from/i.test(normalizedSql) && !/e2e_test_run_id|test_run_id/i.test(sql)) {
    throw new Error("Unsafe cleanup blocked: delete statements must be scoped by the current test-run id column.")
  }

  if (!sql.includes(input.testRunId) && !bindText.includes(input.testRunId)) {
    throw new Error("Unsafe cleanup blocked: cleanup query must bind the current test-run id.")
  }

  return true
}

export function logCleanupPlan(plan: ReturnType<typeof assertDestructiveE2eAllowed>, logger: Pick<Console, "info"> = console) {
  logger.info(
    JSON.stringify(
      {
        operation: plan.operation,
        targetBusinessName: plan.targetBusinessName,
        testRunId: plan.testRunId,
        records: plan.plannedRecords,
      },
      null,
      2
    )
  )
}
