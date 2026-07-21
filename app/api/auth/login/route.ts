import "server-only"
import { createServerClient } from "@supabase/ssr"
import type { PostgrestError, User } from "@supabase/supabase-js"
import { cookies } from "next/headers"
import { z } from "zod"
import { isConfiguredAdmin } from "@/lib/admin-role"
import { getBearerToken, validateMutationOrigin } from "@/lib/api/auth"
import { fail } from "@/lib/api/responses"
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit"
import { authCookieOptions } from "@/lib/supabase/session"

export const dynamic = "force-dynamic"

const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
  next: z.string().optional(),
})

type ProfileGate = {
  role: string | null
  approved: boolean | null
  business_created: boolean | null
  is_suspended: boolean | null
  email?: string | null
}

type SupabaseQueryClient = {
  from: ReturnType<typeof createServerClient>["from"]
}

type LoginLogMeta = {
  requestId: string
  stage: string
  status?: number
  code?: string
  route: string
  runtime: "vercel" | "node" | "unknown"
  supabaseAuthSucceeded?: boolean
  sessionCookiesWritten?: boolean
  profileLookupSucceeded?: boolean
  workspaceLookupSucceeded?: boolean
  redirectTo?: string | null
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

function runtimeName(): LoginLogMeta["runtime"] {
  if (process.env.VERCEL) return "vercel"
  if (process.release?.name === "node") return "node"
  return "unknown"
}

function safeNextPath(value: unknown) {
  if (typeof value !== "string") return "/dashboard"
  return value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard"
}

function publicOrigin(request: Request) {
  const url = new URL(request.url)
  const forwardedProto = request.headers.get("x-forwarded-proto")
  const forwardedHost = request.headers.get("x-forwarded-host")
  if (forwardedProto && forwardedHost) return `${forwardedProto}://${forwardedHost}`
  return url.origin
}

function logLogin(level: "info" | "warn" | "error", meta: LoginLogMeta) {
  console[level]("[auth/login]", meta)
}

function safeError(message: string, status: number, code: string, stage: string, requestId: string) {
  return fail(message, status, { code, stage, requestId })
}

async function optionalAdminClient(): Promise<SupabaseQueryClient | null> {
  try {
    const { adminSupabase } = await import("@/lib/supabase/admin")
    return adminSupabase as SupabaseQueryClient
  } catch {
    return null
  }
}

async function readProfile(client: SupabaseQueryClient, userId: string) {
  return client
    .from("profiles")
    .select("role, approved, business_created, is_suspended, email")
    .eq("id", userId)
    .maybeSingle()
}

async function readProfileWithFallback(client: SupabaseQueryClient, userId: string) {
  let result = (await readProfile(client, userId)) as {
    data: ProfileGate | null
    error: PostgrestError | null
  }
  let lookupClient = client

  if (result.error || !result.data) {
    const adminClient = await optionalAdminClient()
    if (adminClient) {
      const adminResult = (await readProfile(adminClient, userId)) as {
        data: ProfileGate | null
        error: PostgrestError | null
      }
      result = adminResult
      lookupClient = adminClient
    }
  }

  return { ...result, lookupClient }
}

async function hasWorkspace(client: SupabaseQueryClient, userId: string) {
  const [{ data: membership }, { data: ownedOrganization }] = await Promise.all([
    client
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
    client
      .from("organizations")
      .select("id")
      .eq("owner_id", userId)
      .limit(1)
      .maybeSingle(),
  ])

  return Boolean(membership?.organization_id || ownedOrganization?.id)
}

async function resolveDestination(client: SupabaseQueryClient, user: User, requestedNext: string) {
  const { data: profile, error: profileError, lookupClient } = await readProfileWithFallback(client, user.id)
  const admin = isConfiguredAdmin(user.email, profile?.role)

  if (profile?.is_suspended) {
    return {
      ok: false as const,
      status: 403,
      code: "ACCOUNT_SUSPENDED",
      message: "This account is suspended.",
      profileLookupSucceeded: true,
      workspaceLookupSucceeded: false,
    }
  }

  if (profileError || !profile) {
    if (admin) {
      return {
        ok: true as const,
        redirectTo: requestedNext === "/admin" || requestedNext.startsWith("/admin/") ? requestedNext : "/admin",
        profileLookupSucceeded: false,
        workspaceLookupSucceeded: false,
      }
    }

    return {
      ok: false as const,
      status: 404,
      code: "PROFILE_MISSING",
      message: "Your account profile is missing. Contact support to repair access.",
      profileLookupSucceeded: false,
      workspaceLookupSucceeded: false,
    }
  }

  if (admin) {
    return {
      ok: true as const,
      redirectTo: requestedNext === "/admin" || requestedNext.startsWith("/admin/") ? requestedNext : "/admin",
      profileLookupSucceeded: true,
      workspaceLookupSucceeded: false,
    }
  }

  if (profile.approved === false) {
    return {
      ok: false as const,
      status: 403,
      code: "PENDING_APPROVAL",
      message: "Your account is pending approval.",
      profileLookupSucceeded: true,
      workspaceLookupSucceeded: false,
    }
  }

  const workspaceExists = profile.business_created === true || (await hasWorkspace(lookupClient, user.id))
  if (!workspaceExists) {
    return {
      ok: true as const,
      redirectTo: "/create-business",
      profileLookupSucceeded: true,
      workspaceLookupSucceeded: true,
    }
  }

  const unsafeAdminNext = requestedNext === "/admin" || requestedNext.startsWith("/admin/")
  return {
    ok: true as const,
    redirectTo: unsafeAdminNext ? "/dashboard" : requestedNext,
    profileLookupSucceeded: true,
    workspaceLookupSucceeded: true,
  }
}

export async function POST(request: Request) {
  const requestId = crypto.randomUUID()
  const route = new URL(request.url).pathname
  const runtime = runtimeName()

  if (!validateMutationOrigin(request)) {
    logLogin("warn", {
      requestId,
      stage: "validate_origin",
      status: 403,
      code: "INVALID_ORIGIN",
      route,
      runtime,
      supabaseAuthSucceeded: false,
      sessionCookiesWritten: false,
      profileLookupSucceeded: false,
      workspaceLookupSucceeded: false,
      redirectTo: null,
    })
    return safeError("Invalid request origin.", 403, "INVALID_ORIGIN", "validate_origin", requestId)
  }

  const limit = checkRateLimit({
    key: rateLimitKey(request, "auth.login"),
    limit: 20,
    windowMs: 15 * 60 * 1000,
  })

  if (!limit.allowed && !getBearerToken(request)) {
    logLogin("warn", {
      requestId,
      stage: "rate_limit",
      status: 429,
      code: "RATE_LIMITED",
      route,
      runtime,
      supabaseAuthSucceeded: false,
      sessionCookiesWritten: false,
      profileLookupSucceeded: false,
      workspaceLookupSucceeded: false,
      redirectTo: null,
    })
    return safeError("Too many login attempts. Please try again later.", 429, "RATE_LIMITED", "rate_limit", requestId)
  }

  const parsed = loginSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    logLogin("warn", {
      requestId,
      stage: "parse_request",
      status: 400,
      code: "INVALID_REQUEST",
      route,
      runtime,
      supabaseAuthSucceeded: false,
      sessionCookiesWritten: false,
      profileLookupSucceeded: false,
      workspaceLookupSucceeded: false,
      redirectTo: null,
    })
    return safeError("Please enter a valid email and password.", 400, "INVALID_REQUEST", "parse_request", requestId)
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    logLogin("error", {
      requestId,
      stage: "environment",
      status: 500,
      code: "AUTH_ENV_MISSING",
      route,
      runtime,
      supabaseAuthSucceeded: false,
      sessionCookiesWritten: false,
      profileLookupSucceeded: false,
      workspaceLookupSucceeded: false,
      redirectTo: null,
    })
    return safeError("Login is not configured on this deployment.", 500, "AUTH_ENV_MISSING", "environment", requestId)
  }

  const cookieStore = await cookies()
  let sessionCookieWrites = 0
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        sessionCookieWrites += cookiesToSet.length
        cookiesToSet.forEach(({ name, value, options }) => {
          cookieStore.set(name, value, options)
        })
      },
    },
  })

  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  if (error || !data.session || !data.user) {
    const invalidCredentials = error?.message?.toLowerCase().includes("invalid login credentials")
    const status = invalidCredentials ? 401 : 400
    const code = invalidCredentials ? "INVALID_CREDENTIALS" : "SUPABASE_AUTH_FAILED"
    logLogin("warn", {
      requestId,
      stage: "supabase_password_auth",
      status,
      code,
      route,
      runtime,
      supabaseAuthSucceeded: false,
      sessionCookiesWritten: sessionCookieWrites > 0,
      profileLookupSucceeded: false,
      workspaceLookupSucceeded: false,
      redirectTo: null,
    })
    return safeError(
      invalidCredentials ? "Incorrect email or password." : "Login could not be completed.",
      status,
      code,
      "supabase_password_auth",
      requestId
    )
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()

  if (userError || !user) {
    logLogin("warn", {
      requestId,
      stage: "server_session_confirm",
      status: 401,
      code: "SESSION_NOT_CONFIRMED",
      route,
      runtime,
      supabaseAuthSucceeded: true,
      sessionCookiesWritten: sessionCookieWrites > 0,
      profileLookupSucceeded: false,
      workspaceLookupSucceeded: false,
      redirectTo: null,
    })
    return safeError("Login session could not be confirmed.", 401, "SESSION_NOT_CONFIRMED", "server_session_confirm", requestId)
  }

  const destination = await resolveDestination(supabase as SupabaseQueryClient, user, safeNextPath(parsed.data.next))

  if (!destination.ok) {
    logLogin("warn", {
      requestId,
      stage: "destination_authorization",
      status: destination.status,
      code: destination.code,
      route,
      runtime,
      supabaseAuthSucceeded: true,
      sessionCookiesWritten: sessionCookieWrites > 0,
      profileLookupSucceeded: destination.profileLookupSucceeded,
      workspaceLookupSucceeded: destination.workspaceLookupSucceeded,
      redirectTo: null,
    })
    return safeError(destination.message, destination.status, destination.code, "destination_authorization", requestId)
  }

  logLogin("info", {
    requestId,
    stage: "destination_authorized",
    status: 200,
    code: "LOGIN_OK",
    route,
    runtime,
    supabaseAuthSucceeded: true,
    sessionCookiesWritten: sessionCookieWrites > 0,
    profileLookupSucceeded: destination.profileLookupSucceeded,
    workspaceLookupSucceeded: destination.workspaceLookupSucceeded,
    redirectTo: destination.redirectTo,
  })

  return Response.json(
    {
      success: true,
      redirectTo: new URL(destination.redirectTo, publicOrigin(request)).toString(),
      requestId,
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
