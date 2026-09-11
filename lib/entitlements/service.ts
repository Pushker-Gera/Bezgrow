"use client"

import { localLicenseSnapshot } from "@/lib/offline/local/license"
import { hasLocalBusiness } from "@/lib/onboarding/local"

export type EntitlementCapabilities = {
  status: string
  reason: string
  canRead: boolean
  canWrite: boolean
  canUseAccounting: boolean
  canCreateInvoice: boolean
  canManageSubscription: boolean
  isTrial: boolean
  trialStartedAt: string | null
  trialEndsAt: string | null
  validUntil: string | null
  daysRemaining: number
}

function optionalText(value: unknown) {
  return typeof value === "string" && value ? value : null
}

export async function getEntitlementCapabilities(organizationId?: string): Promise<EntitlementCapabilities> {
  const [snapshot, localBusinessId] = await Promise.all([
    localLicenseSnapshot(organizationId),
    hasLocalBusiness(organizationId).catch(() => null),
  ])
  const license = snapshot.license as Record<string, unknown> | null | undefined
  const features = new Set(snapshot.allowedFeatures)
  const trialEndsAt = optionalText(license?.trial_ends_at)
  const validUntil = optionalText(license?.valid_until) || snapshot.expiresAt || null
  const deadline = trialEndsAt || validUntil
  return {
    status: snapshot.status,
    reason: snapshot.reason,
    canRead: Boolean(license || localBusinessId),
    canWrite: snapshot.allowed,
    canUseAccounting: snapshot.allowed && features.has("accounting"),
    canCreateInvoice: snapshot.allowed && features.has("invoices"),
    canManageSubscription: true,
    isTrial: license?.entitlement_source === "self_service_trial" || license?.status === "trial",
    trialStartedAt: optionalText(license?.trial_started_at),
    trialEndsAt,
    validUntil,
    daysRemaining: deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 86_400_000)) : 0,
  }
}

export const canReadERP = (capabilities: EntitlementCapabilities) => capabilities.canRead
export const canWriteERP = (capabilities: EntitlementCapabilities) => capabilities.canWrite
export const canUseAccounting = (capabilities: EntitlementCapabilities) => capabilities.canUseAccounting
export const canCreateInvoice = (capabilities: EntitlementCapabilities) => capabilities.canCreateInvoice
export const canManageSubscription = (capabilities: EntitlementCapabilities) => capabilities.canManageSubscription
