"use client"

import { DEFAULT_ACCOUNTS } from "@/lib/offline/local/accounting"
import { financialYearForDate, isoLocalDate } from "@/lib/financial-years"
import { getLocalDatabaseService } from "@/lib/offline/local/service"
import { activateOfflineLicense, getOrCreateDeviceId } from "@/lib/offline/local/license"
import { parseLicenseInput } from "@/lib/license/codec"
import type { ValidPhase1BusinessOnboarding } from "@/lib/onboarding/validation"

type DataRow = Record<string, unknown>
const service = getLocalDatabaseService()

const FEATURE_KEYS = ["accounting", "backups", "billing", "customers", "inventory", "invoices", "reports", "suppliers"]
const VOUCHER_SERIES = [
  ["JOURNAL", "JV"], ["PAYMENT", "PAY"], ["RECEIPT", "REC"], ["CONTRA", "CON"],
  ["PURCHASE", "PUR"], ["CREDIT_NOTE", "CN"], ["DEBIT_NOTE", "DN"], ["OPENING", "OPENING"],
] as const
const FIXED_ASSET_CATEGORIES = [
  ["PLANT", "Plant & Machinery", 120],
  ["FURNITURE", "Furniture", 120],
  ["COMPUTERS", "Computers", 36],
  ["OFFICE_EQUIPMENT", "Office Equipment", 60],
  ["VEHICLES", "Vehicles", 96],
  ["BUILDINGS", "Buildings", 360],
  ["OTHER", "Other Fixed Assets", 60],
] as const

let onboardingMutation: Promise<unknown> = Promise.resolve()

function nowIso() {
  return new Date().toISOString()
}

function localRequestSnapshot(input: ValidPhase1BusinessOnboarding) {
  const { password: _password, termsAccepted: _termsAccepted, ...safe } = input
  void _password
  void _termsAccepted
  return safe
}

function serializeOnboardingMutation<T>(operation: () => Promise<T>) {
  const pending = onboardingMutation.then(operation, operation)
  onboardingMutation = pending.catch(() => undefined)
  return pending
}

function assertSameOnboardingRequest(existing: LocalOnboardingAttempt, input: ValidPhase1BusinessOnboarding) {
  let stored: unknown
  try {
    stored = JSON.parse(existing.request_json)
  } catch {
    throw new Error("The saved setup request cannot be resumed safely. Contact support before creating another business.")
  }
  if (JSON.stringify(stored) !== JSON.stringify(localRequestSnapshot(input))) {
    throw new Error("This setup request does not match the business already staged on this device. Resume with the saved business details.")
  }
}

export type LocalOnboardingAttempt = {
  id: string
  organization_id: string
  idempotency_key: string
  stage: "LOCAL_READY" | "ACCOUNT_READY" | "ENTITLEMENT_READY" | "APP_LOCK_REQUIRED" | "COMPLETED"
  owner_email: string
  request_json: string
  last_error?: string | null
}

export async function pendingLocalOnboarding() {
  const db = await service.requireConnection("read")
  const [attempt] = await db.select<LocalOnboardingAttempt>(
    "SELECT * FROM onboarding_attempts WHERE stage <> 'COMPLETED' ORDER BY datetime(updated_at) DESC LIMIT 1",
  )
  return attempt || null
}

export async function hasLocalBusiness(organizationId?: string) {
  const db = await service.requireConnection("read")
  const [row] = await db.select<DataRow>(
    `SELECT id FROM organizations
     WHERE deleted_at IS NULL AND id <> 'global' ${organizationId ? "AND id = ?" : ""}
     ORDER BY datetime(COALESCE(joined_at, created_at)), id LIMIT 1`,
    organizationId ? [organizationId] : [],
  )
  return row ? String(row.id) : null
}

export function stageLocalBusiness(input: ValidPhase1BusinessOnboarding) {
  return serializeOnboardingMutation(() => stageLocalBusinessOnce(input))
}

async function stageLocalBusinessOnce(input: ValidPhase1BusinessOnboarding) {
  await service.ensureReady()
  const db = await service.requireConnection("read")
  const [existingAttempt] = await db.select<LocalOnboardingAttempt>(
    "SELECT * FROM onboarding_attempts WHERE idempotency_key = ? LIMIT 1",
    [input.idempotencyKey],
  )
  if (existingAttempt) {
    assertSameOnboardingRequest(existingAttempt, input)
    return existingAttempt
  }
  const [existingBusiness] = await db.select<DataRow>("SELECT id FROM organizations WHERE deleted_at IS NULL AND id <> 'global' LIMIT 1")
  if (existingBusiness && String(existingBusiness.id) !== input.localBusinessId) {
    throw new Error("A local business already exists on this device. Continue its setup or restore from backup.")
  }

  const timestamp = nowIso()
  const userId = `local-user:${input.localBusinessId}`
  const roleId = `role:${input.localBusinessId}:owner`
  const warehouseId = `warehouse:${input.localBusinessId}:main`
  const year = financialYearForDate(input.localBusinessId, isoLocalDate(), input.financialYearStartMonth)
  const requestJson = JSON.stringify(localRequestSnapshot(input))
  const attemptId = `onboarding:${input.idempotencyKey}`

  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO organizations (
        id, owner_id, owner_name, owner_phone, name, business_name, industry, business_type,
        gst_number, gst_registered, tax_id, pan, phone, email, address, city, state, postal_code,
        country, currency, timezone, locale, branch_name, invoice_prefix, next_invoice_number,
        financial_year_start, joined_at, sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'India', 'INR', 'Asia/Kolkata', 'en-IN', 'Main Branch', ?, 1, ?, ?, 'local', ?, ?)`,
      [
        input.localBusinessId, userId, input.ownerName, input.mobile, input.businessName, input.businessName,
        input.industry, input.businessType, input.gstin || null, input.gstRegistered ? 1 : 0, input.pan || null,
        input.pan || null, input.mobile, input.email, input.address, input.city, input.state, input.postalCode,
        input.invoicePrefix, year.startDate, timestamp, timestamp, timestamp,
      ],
    )
    await tx.execute(
      `INSERT INTO local_users (id, organization_id, email, full_name, role, approved, business_created, is_suspended, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'owner', 1, 1, 0, 'local', ?, ?)`,
      [userId, input.localBusinessId, input.email, input.ownerName, timestamp, timestamp],
    )
    await tx.execute(
      "INSERT INTO roles (id, organization_id, name, label, is_system, created_at, updated_at) VALUES (?, ?, 'owner', 'Owner', 1, ?, ?)",
      [roleId, input.localBusinessId, timestamp, timestamp],
    )
    await tx.execute(
      `INSERT INTO organization_members (id, organization_id, user_id, role, is_active, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', 1, 'local', ?, ?)`,
      [`member:${input.localBusinessId}:${userId}`, input.localBusinessId, userId, timestamp, timestamp],
    )
    await tx.execute(
      `INSERT INTO warehouses (id, organization_id, name, code, address, is_active, sync_status, created_at, updated_at)
       VALUES (?, ?, 'Main Warehouse', 'MAIN', ?, 1, 'local', ?, ?)`,
      [warehouseId, input.localBusinessId, `${input.address}, ${input.city}`, timestamp, timestamp],
    )
    for (const feature of FEATURE_KEYS) {
      await tx.execute(
        "INSERT INTO feature_flags (id, organization_id, feature_key, is_enabled, updated_at) VALUES (?, ?, ?, 1, ?)",
        [`feature:${input.localBusinessId}:${feature}`, input.localBusinessId, feature, timestamp],
      )
    }
    const settings: Array<[string, string]> = [
      ["onboarding_version", "phase1"], ["country", "India"], ["currency", "INR"],
      ["timezone", "Asia/Kolkata"], ["invoice_prefix", input.invoicePrefix],
      ["financial_year_start_month", String(input.financialYearStartMonth)],
    ]
    for (const [key, value] of settings) {
      await tx.execute(
        "INSERT INTO business_settings (id, organization_id, key, value_text, updated_at) VALUES (?, ?, ?, ?, ?)",
        [`setting:${input.localBusinessId}:${key}`, input.localBusinessId, key, value, timestamp],
      )
    }
    await tx.execute(
      `INSERT INTO financial_years (
        id, organization_id, label, start_date, end_date, start_month, status, is_active,
        invoice_numbering_mode, created_at, schema_version
      ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 1, 'CONTINUE', ?, 1)`,
      [year.id, input.localBusinessId, year.label, year.startDate, year.endDate, year.startMonth, timestamp],
    )
    await tx.execute(
      "INSERT INTO financial_year_invoice_sequences (id, organization_id, financial_year_id, prefix, next_number, updated_at) VALUES (?, ?, ?, ?, 1, ?)",
      [`invoice-sequence:${year.id}`, input.localBusinessId, year.id, input.invoicePrefix, timestamp],
    )
    for (const [code, name, type, group, normal, role] of DEFAULT_ACCOUNTS) {
      await tx.execute(
        `INSERT INTO chart_of_accounts (
          id, organization_id, account_code, account_name, account_type, account_group, normal_balance,
          opening_balance, current_balance, is_system, is_cash_account, is_bank_account, is_active,
          system_role, tax_role, cash_flow_classification, sync_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, 1, ?, ?, ?, 'local', ?, ?)`,
        [
          `account:${input.localBusinessId}:${code}`, input.localBusinessId, code, name, type, group, normal,
          role === "CASH" ? 1 : 0, role === "BANK" ? 1 : 0, role,
          role.startsWith("INPUT_") || role.startsWith("OUTPUT_") ? role : null,
          ["FIXED_ASSETS", "ACCUMULATED_DEPRECIATION", "DEPRECIATION_EXPENSE", "ASSET_DISPOSAL_GAIN", "ASSET_DISPOSAL_LOSS"].includes(role)
            ? "INVESTING"
            : ["CAPITAL", "OPENING_EQUITY", "DRAWINGS"].includes(role) ? "FINANCING" : "OPERATING",
          timestamp, timestamp,
        ],
      )
    }
    await tx.execute(
      `INSERT INTO accounting_settings (
        organization_id, accounting_version, activation_date, opening_date, historical_policy,
        initialization_status, warning_count, initialized_at, created_at, updated_at
      ) VALUES (?, 3, ?, ?, 'CONTROLLED_OPENING', 'INITIALIZED', 0, ?, ?, ?)`,
      [input.localBusinessId, isoLocalDate(), isoLocalDate(), timestamp, timestamp, timestamp],
    )
    for (const [type, prefix] of VOUCHER_SERIES) {
      await tx.execute(
        `INSERT INTO accounting_sequences (
          id, organization_id, financial_year_id, voucher_type, prefix, next_number, suffix, padding, starting_number, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, NULL, 6, 1, ?)`,
        [`accounting-sequence:${year.id}:${type}`, input.localBusinessId, year.id, type, prefix, timestamp],
      )
      await tx.execute(
        `INSERT INTO accounting_voucher_series (
          id, organization_id, financial_year_id, voucher_type, prefix, suffix, padding, starting_number, next_number, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 6, 1, 1, 1, ?, ?)`,
        [`voucher-series:${year.id}:${type}`, input.localBusinessId, year.id, type, prefix, timestamp, timestamp],
      )
    }
    for (const [code, name, life] of FIXED_ASSET_CATEGORIES) {
      await tx.execute(
        `INSERT INTO fixed_asset_categories (
          id, organization_id, code, name, default_method, default_useful_life_months,
          default_rate_basis_points, asset_account_id, accumulated_depreciation_account_id,
          depreciation_expense_account_id, is_active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'SLM', ?, 0, ?, ?, ?, 1, ?, ?)`,
        [
          `asset-category:${input.localBusinessId}:${code}`, input.localBusinessId, code, name, life,
          `account:${input.localBusinessId}:1500`, `account:${input.localBusinessId}:1510`,
          `account:${input.localBusinessId}:6090`, timestamp, timestamp,
        ],
      )
    }
    for (const type of ["E_INVOICE", "E_WAY_BILL", "GST_RETURN"] as const) {
      await tx.execute(
        "INSERT INTO statutory_integrations (id, organization_id, integration_type, configuration_status, created_at, updated_at) VALUES (?, ?, ?, 'NOT_CONFIGURED', ?, ?)",
        [`statutory:${input.localBusinessId}:${type}`, input.localBusinessId, type, timestamp, timestamp],
      )
    }
    await tx.execute(
      `INSERT INTO onboarding_attempts (
        id, organization_id, idempotency_key, stage, owner_email, request_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'LOCAL_READY', ?, ?, ?, ?)`,
      [attemptId, input.localBusinessId, input.idempotencyKey, input.email, requestJson, timestamp, timestamp],
    )
    await tx.execute(
      `INSERT INTO local_audit_logs (
        id, organization_id, user_id, action, entity_type, entity_id, description, sync_status, created_at, updated_at
      ) VALUES (?, ?, ?, 'business.onboarding_staged', 'organization', ?, 'Created an empty local-first business and initialized its accounting foundation.', 'local', ?, ?)`,
      [`audit:${crypto.randomUUID()}`, input.localBusinessId, userId, input.localBusinessId, timestamp, timestamp],
    )
  })

  return {
    id: attemptId,
    organization_id: input.localBusinessId,
    idempotency_key: input.idempotencyKey,
    stage: "LOCAL_READY" as const,
    owner_email: input.email,
    request_json: requestJson,
  }
}

export async function recordOnboardingFailure(idempotencyKey: string, message: string) {
  await service.execute(
    "UPDATE onboarding_attempts SET last_error = ?, updated_at = ? WHERE idempotency_key = ?",
    [message.slice(0, 500), nowIso(), idempotencyKey],
  )
}

export type OnboardingControlPlaneResult = {
  account: { id: string; platformCustomerId: string; email: string; emailVerified?: boolean }
  business: { id: string; platformBusinessId: string; name: string }
  subscription: {
    id: string
    status: string
    trialStartedAt: string
    trialEndsAt: string
    planCode: string
    planName: string
    amountMinor: number
    currency: string
  }
  entitlement: { id: string; status: string; validUntil: string; signedEntitlement: string }
  serverTime: string
}

export async function installOnboardingEntitlement(result: OnboardingControlPlaneResult) {
  if (!result.account.platformCustomerId) {
    throw new Error("Bezgrow account setup did not return a platform customer identity. Retry setup when online.")
  }
  const deviceId = await getOrCreateDeviceId()
  const candidate = parseLicenseInput(result.entitlement.signedEntitlement).payload
  if (
    candidate.business_id !== result.business.id
    || candidate.customer_id !== result.account.id
    || candidate.device_id !== deviceId
  ) {
    throw new Error("The signed trial entitlement does not match this account and business.")
  }
  const parsed = await activateOfflineLicense(result.entitlement.signedEntitlement)
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `UPDATE organizations SET platform_customer_id = ?, platform_business_id = ?, owner_id = ?, updated_at = ? WHERE id = ?`,
      [result.account.platformCustomerId, result.business.platformBusinessId, result.account.id, timestamp, result.business.id],
    )
    const planSettings: Array<[string, string]> = [
      ["subscription_plan_code", result.subscription.planCode],
      ["subscription_plan_name", result.subscription.planName],
      ["subscription_amount_minor", String(result.subscription.amountMinor)],
      ["subscription_currency", result.subscription.currency],
    ]
    for (const [key, value] of planSettings) {
      await tx.execute(
        `INSERT INTO business_settings (id, organization_id, key, value_text, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET value_text = excluded.value_text, updated_at = excluded.updated_at`,
        [`setting:${result.business.id}:${key}`, result.business.id, key, value, timestamp],
      )
    }
    await tx.execute(
      `INSERT OR REPLACE INTO local_account_bindings (
        id, organization_id, account_user_id, account_email, platform_customer_id, platform_business_id,
        subscription_id, entitlement_id, device_id, bound_at, last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `account-binding:${result.entitlement.id}`, result.business.id, result.account.id, result.account.email,
        result.account.platformCustomerId, result.business.platformBusinessId, result.subscription.id, result.entitlement.id,
        deviceId, timestamp, result.serverTime,
      ],
    )
    await tx.execute(
      `UPDATE onboarding_attempts SET stage = 'APP_LOCK_REQUIRED', last_error = NULL, updated_at = ? WHERE organization_id = ?`,
      [timestamp, result.business.id],
    )
  })
  return parsed
}

export async function markOnboardingComplete(organizationId: string) {
  const timestamp = nowIso()
  await service.execute(
    "UPDATE onboarding_attempts SET stage = 'COMPLETED', completed_at = ?, updated_at = ?, last_error = NULL WHERE organization_id = ?",
    [timestamp, timestamp, organizationId],
  )
}
