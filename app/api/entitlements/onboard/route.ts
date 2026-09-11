import "server-only"

import { createClient } from "@supabase/supabase-js"
import { adminSupabase } from "@/lib/supabase/admin"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { validateMutationOrigin } from "@/lib/api/auth"
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit"
import {
  onboardingValidationMessage,
  phase1BusinessOnboardingSchema,
} from "@/lib/onboarding/validation"
import { LICENSE_SCHEMA_VERSION, type LicensePayload } from "@/lib/license/codec"
import { signLicensePayload } from "@/lib/license/server"
import { verifyOnboardingDeviceProof } from "@/lib/device/onboarding-proof"
import { verifyAdminControlPlaneSchema } from "@/lib/admin/schema-readiness"

export const dynamic = "force-dynamic"

type TrialRpcRecord = Record<string, unknown>
type TrialRpcResult = {
  customer: TrialRpcRecord
  business: TrialRpcRecord
  subscription: TrialRpcRecord
  entitlement: TrialRpcRecord
  license: TrialRpcRecord
  plan: TrialRpcRecord
  server_time: string
  resumed: boolean
}

type TrialFinalizeResult = {
  signed_entitlement: string
  entitlement: TrialRpcRecord
  server_time: string
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

class EmailVerificationRequiredError extends Error {}

async function resolveAccount(email: string, password: string, ownerName: string, businessName: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) throw new Error("Account verification is unavailable.")
  const authClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://www.bezgrow.com"
  const confirmationUrl = new URL("/auth/callback", siteOrigin)
  confirmationUrl.searchParams.set("next", "/login?verified=1")
  const existing = await authClient.auth.signInWithPassword({ email, password })
  if (existing.data.user) {
    await authClient.auth.signOut().catch(() => undefined)
    return { user: existing.data.user, created: false }
  }
  if ((existing.error as { code?: string } | null)?.code === "email_not_confirmed") {
    await authClient.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: confirmationUrl.toString() },
    }).catch(() => undefined)
    throw new EmailVerificationRequiredError("Check your email and confirm the Bezgrow account, then choose Resume trial setup. Your local business is safe.")
  }

  const signup = await authClient.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: ownerName, business_name: businessName },
      emailRedirectTo: confirmationUrl.toString(),
    },
  })
  if (signup.error) throw signup.error
  if (!signup.data.user) {
    throw new Error("This email is already registered. Sign in with its password or use another email.")
  }
  if (signup.data.user.identities?.length === 0) {
    throw new Error("This email is already registered. Sign in with its password or use another email.")
  }
  if (!signup.data.session) {
    throw new EmailVerificationRequiredError("Check your email and confirm the Bezgrow account, then choose Resume trial setup. Your local business is safe.")
  }
  await authClient.auth.signOut().catch(() => undefined)
  return { user: signup.data.user, created: true }
}

async function removeUncommittedAccount(userId: string) {
  const removed = await adminSupabase.auth.admin.deleteUser(userId)
  if (removed.error) {
    console.error("[entitlements/onboard] unable to remove uncommitted account", {
      userId,
      code: removed.error.code,
      message: removed.error.message,
    })
  }
}

export async function POST(request: Request) {
  try {
    if (!validateMutationOrigin(request)) return fail("Invalid request origin.", 403)
    const limit = checkRateLimit({
      key: rateLimitKey(request, "entitlements.onboard"),
      limit: 8,
      windowMs: 60 * 60 * 1000,
    })
    if (!limit.allowed) return fail("Too many setup attempts. Please wait and try again.", 429)

    const readiness = await verifyAdminControlPlaneSchema(crypto.randomUUID())
    if (!readiness.ready) {
      return fail("Bezgrow account setup is temporarily unavailable. Your local business data has not been changed.", 503)
    }

    const parsed = phase1BusinessOnboardingSchema.safeParse(await request.clone().json().catch(() => null))
    if (!parsed.success) return fail(onboardingValidationMessage(parsed.error), 400)
    const input = parsed.data
    if (request.headers.get("idempotency-key") !== input.idempotencyKey) {
      return fail("The setup retry key does not match this saved business request.", 409)
    }
    const deviceProof = await verifyOnboardingDeviceProof(request, input.deviceId)
    if (!deviceProof) return fail("This setup request could not be verified as coming from this Bezgrow installation.", 403)
    const deviceLimit = checkRateLimit({
      key: `entitlements.onboard:device:${input.deviceId}`,
      limit: 8,
      windowMs: 60 * 60 * 1000,
    })
    if (!deviceLimit.allowed) return fail("Too many setup attempts from this device. Please wait and try again.", 429)
    const account = await resolveAccount(input.email, input.password, input.ownerName, input.businessName)

    const existingProfile = await adminSupabase.from("profiles")
      .select("id,role,is_suspended")
      .eq("id", account.user.id)
      .maybeSingle()
    if (existingProfile.error) throw existingProfile.error
    if (existingProfile.data?.is_suspended) {
      return fail("This Bezgrow account is suspended. Contact support before creating a business.", 403)
    }
    const profile = existingProfile.data
      ? await adminSupabase.from("profiles").update({
          email: input.email,
          full_name: input.ownerName,
          updated_at: new Date().toISOString(),
        }).eq("id", account.user.id)
      : await adminSupabase.from("profiles").insert({
          id: account.user.id,
          email: input.email,
          full_name: input.ownerName,
          role: "user",
          business_created: false,
          is_suspended: false,
          updated_at: new Date().toISOString(),
        })
    if (profile.error) {
      if (account.created) await removeUncommittedAccount(account.user.id)
      throw profile.error
    }

    const rpc = await adminSupabase.rpc("begin_phase1_trial", {
      p_auth_user_id: account.user.id,
      p_owner_name: input.ownerName,
      p_email: input.email,
      p_phone: input.mobile,
      p_workspace_id: input.localBusinessId,
      p_business_name: input.businessName,
      p_business_type: input.businessType,
      p_industry: input.industry,
      p_gst_registered: input.gstRegistered,
      p_registered_state: input.state,
      p_device_id: input.deviceId,
      p_platform: input.platform,
      p_architecture: input.architecture,
      p_app_version: input.appVersion,
      p_idempotency_key: input.idempotencyKey,
      p_device_public_key: deviceProof.publicKey,
      p_email_verified: Boolean(account.user.email_confirmed_at),
    })
    if (rpc.error) {
      // A named Phase 1 database exception means the transaction rolled back.
      // Remove only an account created by this request so a device/account
      // conflict cannot leave an unusable orphan. Ambiguous network errors are
      // intentionally retained for idempotent recovery.
      if (account.created && rpc.error.message.includes("phase1_trial_")) {
        await removeUncommittedAccount(account.user.id)
      }
      const message = rpc.error.message.includes("phase1_trial_legacy_entitlement_exists")
        ? "This device already has a Bezgrow licence. Use account recovery or contact support; a second trial was not started."
        : rpc.error.message.includes("phase1_trial_device_")
        ? "This device has already used its Bezgrow trial. Sign in to the linked account or contact support."
        : rpc.error.message.includes("phase1_trial_account_") || rpc.error.message.includes("phase1_trial_account_conflict")
          ? "This email is linked to another Bezgrow account. Sign in to that account or contact support."
          : rpc.error.message.includes("phase1_trial_workspace_") || rpc.error.message.includes("phase1_trial_idempotency_")
            ? "This saved business setup does not match the original request. Use recovery or contact support."
          : "The trial could not be created. Your local business is safe; retry setup when online."
      return fail(message, rpc.error.message.includes("phase1_trial_") ? 409 : 503)
    }

    const result = rpc.data as TrialRpcResult
    const entitlement = result.entitlement
    const validUntil = textValue(entitlement.valid_until)
    const stableIssuedAt = textValue(entitlement.valid_from)
    const effectiveStatus = textValue(entitlement.status) === "expired" ? "expired" : "trialing"
    const proposedPayload: LicensePayload = {
        schema_version: LICENSE_SCHEMA_VERSION,
        license_id: textValue(entitlement.license_id),
        customer_id: account.user.id,
        customer_name: textValue(result.customer.name),
        customer_email: textValue(result.customer.email),
        business_id: textValue(result.business.workspace_id),
        business_name: textValue(result.business.business_name),
        device_id: textValue(entitlement.device_id),
        platform: textValue(result.license.platform),
        architecture: textValue(result.license.architecture),
        app_version: textValue(result.license.app_version),
        plan_name: textValue(result.plan.name),
        issue_date: textValue(entitlement.valid_from).slice(0, 10),
        expiry_date: validUntil.slice(0, 10),
        grace_period_days: 0,
        allowed_features: Array.isArray(entitlement.allowed_features) ? entitlement.allowed_features.map(String).sort() : [],
        maximum_users: 1,
        maximum_businesses: 1,
        maximum_branches: 1,
        issued_by_admin: "Bezgrow self-service control plane",
        issued_at: stableIssuedAt,
        entitlement_id: textValue(entitlement.id),
        entitlement_source: "self_service_trial",
        entitlement_status: effectiveStatus,
        subscription_id: textValue(entitlement.subscription_id),
        trial_started_at: textValue(entitlement.trial_started_at),
        trial_ends_at: textValue(entitlement.trial_ends_at),
        valid_from: textValue(entitlement.valid_from),
        valid_until: validUntil,
        server_verified_at: stableIssuedAt,
        notes: "30-day self-service trial. Operational ERP data remains on the desktop device.",
    }
    const proposed = signLicensePayload(proposedPayload)
    const finalized = await adminSupabase.rpc("finalize_phase1_trial_entitlement", {
      p_entitlement_id: textValue(entitlement.id),
      p_signed_entitlement: proposed.license_key,
      p_signature_algorithm: proposed.payload.signature_algorithm,
      p_issuer_key_id: proposed.payload.issuer_key_id,
    })
    if (finalized.error) throw finalized.error
    const finalResult = finalized.data as TrialFinalizeResult
    const signedEntitlement = textValue(finalResult.signed_entitlement)
    const { parseLicenseInput } = await import("@/lib/license/codec")
    const signedPayload = parseLicenseInput(signedEntitlement).payload

    const profileReady = await adminSupabase.from("profiles")
      .update({ business_created: true, updated_at: new Date().toISOString() })
      .eq("id", account.user.id)
    if (profileReady.error) throw profileReady.error

    return ok({
      account: {
        id: account.user.id,
        platformCustomerId: textValue(result.customer.id),
        email: textValue(result.customer.email),
        emailVerified: Boolean(account.user.email_confirmed_at),
      },
      business: {
        id: textValue(result.business.workspace_id),
        platformBusinessId: textValue(result.business.id),
        name: textValue(result.business.business_name),
      },
      subscription: {
        id: textValue(result.subscription.id),
        planCode: textValue(result.plan.code),
        planName: textValue(result.plan.name),
        status: textValue(result.subscription.status),
        trialStartedAt: signedPayload.trial_started_at,
        trialEndsAt: signedPayload.trial_ends_at,
        amountMinor: Number(result.plan.price_minor),
        currency: textValue(result.plan.currency),
      },
      entitlement: {
        id: signedPayload.entitlement_id,
        status: signedPayload.entitlement_status,
        validUntil: signedPayload.valid_until,
        signedEntitlement,
      },
      serverTime: finalResult.server_time,
      resumed: result.resumed,
    }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof EmailVerificationRequiredError) {
      return fail(error.message, 409, { code: "email_verification_required" })
    }
    if (error instanceof Error && error.message.startsWith("This email is already registered")) {
      return fail(error.message, 409)
    }
    console.error("[entitlements/onboard] setup failed", error)
    return serverFail()
  }
}
