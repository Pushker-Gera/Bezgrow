import "server-only"

import { z } from "zod"
import { requireAdminControlPlane } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  csvResponse,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const rangeSchema = z.coerce.number().int().min(7).max(365).default(30)

type SectionStatus = "ok" | "not_configured" | "never_reported" | "error"
type DashboardSection = {
  status: SectionStatus
  source: string
  notes?: string
  code?: string
  message?: string
  metrics?: Record<string, number>
  count?: number
  latestMac?: Record<string, unknown> | null
  latestWindows?: Record<string, unknown> | null
  recent?: Array<Record<string, unknown>>
  failures?: Array<Record<string, unknown>>
  security?: Array<Record<string, unknown>>
  cases?: Array<Record<string, unknown>>
}
type DashboardSections = Record<
  "licenses" | "devices" | "businesses" | "customers" | "releases" | "backups" | "support" | "audit" | "analytics",
  DashboardSection
>

type DbError = {
  code?: string
  message?: string
}

function dateText(date: Date) {
  return date.toISOString().slice(0, 10)
}

function sectionError(requestId: string, section: string, source: string, error: DbError) {
  console.error("[admin-dashboard-section]", {
    requestId,
    section,
    source,
    databaseCode: error.code || "unknown",
    databaseMessage: error.message || "Unknown database error",
  })
  return {
    status: "error",
    source,
    code: "SECTION_QUERY_FAILED",
    message: `${section[0].toUpperCase()}${section.slice(1)} metrics could not be loaded.`,
  } satisfies DashboardSection
}

function effectiveLicenseMetrics(
  rows: Array<{ status?: string | null; expiry_date?: string | null; grace_days?: number | null }>
) {
  const today = new Date(`${dateText(new Date())}T00:00:00.000Z`)
  const day = 86_400_000
  const metrics = {
    active: 0,
    expiring7: 0,
    expiring30: 0,
    expiring90: 0,
    gracePeriod: 0,
    expired: 0,
    revoked: 0,
    suspended: 0,
    trial: 0,
  }

  for (const row of rows) {
    const status = String(row.status || "draft")
    const expiry = row.expiry_date
      ? new Date(`${row.expiry_date.slice(0, 10)}T23:59:59.999Z`)
      : null
    const graceEnd = expiry
      ? new Date(expiry.getTime() + Number(row.grace_days || 0) * day)
      : null
    const daysUntilExpiry = expiry
      ? Math.ceil((expiry.getTime() - today.getTime()) / day)
      : Number.POSITIVE_INFINITY
    const eligible = ["active", "trial", "expiring"].includes(status)

    if (status === "revoked") metrics.revoked += 1
    if (status === "suspended") metrics.suspended += 1
    if (status === "trial") metrics.trial += 1
    if (eligible && daysUntilExpiry >= 0 && daysUntilExpiry <= 7) metrics.expiring7 += 1
    if (eligible && daysUntilExpiry >= 0 && daysUntilExpiry <= 30) metrics.expiring30 += 1
    if (eligible && daysUntilExpiry >= 0 && daysUntilExpiry <= 90) metrics.expiring90 += 1

    if (
      expiry &&
      graceEnd &&
      today > expiry &&
      today <= graceEnd &&
      !["draft", "suspended", "revoked", "replaced"].includes(status)
    ) {
      metrics.gracePeriod += 1
    } else if (
      status === "expired" ||
      (expiry &&
        graceEnd &&
        today > graceEnd &&
        ["active", "trial", "expiring", "grace_period", "expired"].includes(status))
    ) {
      metrics.expired += 1
    } else if (status === "active" && (!expiry || today <= expiry)) {
      metrics.active += 1
    }
  }
  return metrics
}

function summaryFromSections(sections: DashboardSections) {
  return {
    licenses: sections.licenses.metrics || {},
    devices: sections.devices.metrics || {},
    customers: sections.customers.count,
    businesses: sections.businesses.count,
    backup: sections.backups.metrics || {},
    supportAttention: sections.support.metrics?.attention,
    latestMacRelease: sections.releases.latestMac || null,
    latestWindowsRelease: sections.releases.latestWindows || null,
    recentAdminActions: sections.audit.recent || [],
    recentActivationFailures: sections.audit.failures || [],
    recentSecurityEvents: sections.audit.security || [],
    supportCases: sections.support.cases || [],
  }
}

function normalizeRpcSections(value: unknown): DashboardSections | null {
  if (!value || typeof value !== "object") return null
  const record = value as { sections?: unknown }
  if (!record.sections || typeof record.sections !== "object") return null
  const sections = record.sections as Record<string, DashboardSection>
  const names = [
    "licenses",
    "devices",
    "businesses",
    "customers",
    "releases",
    "backups",
    "support",
    "audit",
    "analytics",
  ] as const
  if (!names.every((name) => sections[name]?.status && sections[name]?.source)) return null
  return sections as DashboardSections
}

async function loadIsolatedSections(requestId: string, days: number): Promise<DashboardSections> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const today = `${dateText(new Date())}T00:00:00.000Z`

  const [
    licenses,
    devices,
    checkins,
    businesses,
    customers,
    releases,
    backups,
    support,
    audit,
    licenseEvents,
  ] = await Promise.all([
    adminSupabase.from("licenses").select("status,expiry_date,grace_days"),
    adminSupabase.from("registered_devices").select("id,activation_date,last_reported_at"),
    adminSupabase
      .from("device_checkins")
      .select("update_check_result,reported_at")
      .gte("reported_at", since)
      .limit(10000),
    adminSupabase.from("platform_businesses").select("id", { count: "exact", head: true }),
    adminSupabase.from("platform_customers").select("id", { count: "exact", head: true }),
    adminSupabase
      .from("desktop_releases")
      .select("id,version,build_number,platform,architecture,release_channel,release_status,published_at,mandatory")
      .eq("release_status", "published")
      .eq("active", true)
      .order("published_at", { ascending: false })
      .limit(50),
    adminSupabase
      .from("backup_status")
      .select("cloud_backup_enabled,last_successful_backup_at,last_failed_backup_at")
      .limit(10000),
    adminSupabase
      .from("support_cases")
      .select("id,case_number,subject,status,priority,updated_at")
      .order("updated_at", { ascending: false })
      .limit(100),
    adminSupabase
      .from("admin_audit_logs")
      .select("id,admin_email,action,target_type,target_id,result,request_id,created_at")
      .order("created_at", { ascending: false })
      .limit(100),
    adminSupabase
      .from("license_events")
      .select("id,created_at")
      .gte("created_at", since)
      .limit(10000),
  ])

  const licenseSection = licenses.error
    ? sectionError(requestId, "licenses", "public.licenses", licenses.error)
    : {
        status: "ok",
        source: "public.licenses",
        metrics: effectiveLicenseMetrics(licenses.data || []),
        notes: "Authoritative signed-license metadata only.",
      } satisfies DashboardSection

  const deviceSection =
    devices.error || checkins.error
      ? sectionError(
          requestId,
          "devices",
          "public.registered_devices + public.device_checkins",
          devices.error || checkins.error || {}
        )
      : {
          status: (devices.data || []).length ? "ok" : "never_reported",
          source: "public.registered_devices + public.device_checkins",
          metrics: {
            total: (devices.data || []).length,
            activatedToday: (devices.data || []).filter(
              (row) => row.activation_date && row.activation_date >= today
            ).length,
            active30Days: (devices.data || []).filter(
              (row) =>
                row.last_reported_at &&
                Date.parse(row.last_reported_at) >= Date.now() - 30 * 86_400_000
            ).length,
            failedUpdateChecks: (checkins.data || []).filter(
              (row) => row.update_check_result === "failed"
            ).length,
          },
          notes: (devices.data || []).length
            ? "Last reported during authenticated online contact."
            : "No authenticated device report has been received.",
        } satisfies DashboardSection

  const businessSection = businesses.error
    ? sectionError(requestId, "businesses", "public.platform_businesses", businesses.error)
    : {
        status: "ok",
        source: "public.platform_businesses",
        count: businesses.count || 0,
        notes: "Platform workspace metadata; local ERP records are excluded.",
      } satisfies DashboardSection

  const customerSection = customers.error
    ? sectionError(requestId, "customers", "public.platform_customers", customers.error)
    : {
        status: "ok",
        source: "public.platform_customers",
        count: customers.count || 0,
      } satisfies DashboardSection

  const releaseRows = releases.data || []
  const releaseSection = releases.error
    ? sectionError(requestId, "releases", "public.desktop_releases", releases.error)
    : {
        status: releaseRows.length ? "ok" : "not_configured",
        source: "public.desktop_releases + public.release_artifacts",
        latestMac: releaseRows.find((row) => row.platform === "macos") || null,
        latestWindows: releaseRows.find((row) => row.platform === "windows") || null,
        notes: releaseRows.length
          ? "Published release metadata."
          : "No validated release has been published.",
      } satisfies DashboardSection

  const backupRows = backups.data || []
  const backupSection = backups.error
    ? sectionError(requestId, "backups", "public.backup_status", backups.error)
    : {
        status: backupRows.length ? "ok" : "not_configured",
        source: "public.backup_status",
        metrics: {
          enabled: backupRows.filter((row) => row.cloud_backup_enabled).length,
          failed: backupRows.filter(
            (row) =>
              row.last_failed_backup_at &&
              (!row.last_successful_backup_at ||
                Date.parse(row.last_failed_backup_at) > Date.parse(row.last_successful_backup_at))
          ).length,
        },
        notes: backupRows.length
          ? "Consented backup metadata only."
          : "No workspace has configured cloud backup.",
      } satisfies DashboardSection

  const supportRows = support.data || []
  const attentionCases = supportRows.filter(
    (row) => row.status !== "resolved" && ["high", "urgent"].includes(row.priority)
  )
  const supportSection = support.error
    ? sectionError(requestId, "support", "public.support_cases", support.error)
    : {
        status: "ok",
        source: "public.support_cases",
        metrics: { attention: attentionCases.length },
        cases: attentionCases.slice(0, 8),
      } satisfies DashboardSection

  const auditRows = audit.data || []
  const auditSection = audit.error
    ? sectionError(requestId, "audit", "public.admin_audit_logs", audit.error)
    : {
        status: auditRows.length ? "ok" : "never_reported",
        source: "public.admin_audit_logs",
        recent: auditRows.slice(0, 8),
        failures: auditRows
          .filter(
            (row) =>
              ["LICENSE_ACTIVATION_FAILED", "ADMIN_LOGIN_FAILED"].includes(row.action) &&
              row.result === "failure"
          )
          .slice(0, 8),
        security: auditRows
          .filter((row) =>
            ["ADMIN_LOGIN_FAILED", "LICENSE_REVOKED", "DEVICE_REVOKED", "INTEGRITY_EVENT"].includes(
              row.action
            )
          )
          .slice(0, 8),
        notes: auditRows.length
          ? "Append-only administrative and security events."
          : "No control-plane event has been recorded.",
      } satisfies DashboardSection

  const analyticsSection =
    checkins.error || licenseEvents.error
      ? sectionError(
          requestId,
          "analytics",
          "public.device_checkins + public.license_events",
          checkins.error || licenseEvents.error || {}
        )
      : {
          status:
            (checkins.data || []).length || (licenseEvents.data || []).length
              ? "ok"
              : "never_reported",
          source: "public.device_checkins + public.license_events",
          metrics: {
            deviceReports: (checkins.data || []).length,
            licenseEvents: (licenseEvents.data || []).length,
          },
          notes: `Range: ${days} days. Local customer sales and inventory are excluded.`,
        } satisfies DashboardSection

  return {
    licenses: licenseSection,
    devices: deviceSection,
    businesses: businessSection,
    customers: customerSection,
    releases: releaseSection,
    backups: backupSection,
    support: supportSection,
    audit: auditSection,
    analytics: analyticsSection,
  }
}

function dashboardCsvRows(sections: DashboardSections, days: number) {
  const generatedAt = new Date().toISOString()
  const rangeEnd = dateText(new Date())
  const rangeStart = dateText(new Date(Date.now() - days * 86_400_000))
  const rows: Array<Record<string, unknown>> = []
  const pushMetric = (
    sectionName: keyof DashboardSections,
    metricName: string,
    metricValue: unknown,
    notes?: string
  ) => {
    const section = sections[sectionName]
    rows.push({
      date_range: `${rangeStart} to ${rangeEnd}`,
      generated_at: generatedAt,
      metric_name: metricName,
      metric_value: metricValue ?? "",
      status: section.status,
      source: section.source,
      notes: notes || section.notes || "",
    })
  }

  for (const [name, value] of Object.entries(sections.licenses.metrics || {})) {
    pushMetric("licenses", `licenses.${name}`, value)
  }
  for (const [name, value] of Object.entries(sections.devices.metrics || {})) {
    pushMetric("devices", `devices.${name}`, value)
  }
  pushMetric("customers", "customers.total", sections.customers.count)
  pushMetric("businesses", "businesses.total", sections.businesses.count)
  pushMetric("releases", "releases.mac_published", sections.releases.latestMac ? 1 : 0)
  pushMetric("releases", "releases.windows_published", sections.releases.latestWindows ? 1 : 0)
  for (const [name, value] of Object.entries(sections.backups.metrics || {})) {
    pushMetric("backups", `backups.${name}`, value)
  }
  for (const [name, value] of Object.entries(sections.support.metrics || {})) {
    pushMetric("support", `support.${name}`, value)
  }
  for (const [name, value] of Object.entries(sections.analytics.metrics || {})) {
    pushMetric("analytics", `analytics.${name}`, value)
  }
  pushMetric("audit", "audit.recent_actions", sections.audit.recent?.length || 0)
  return rows
}

export async function GET(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) {
    return adminFail(
      { requestId: crypto.randomUUID() },
      auth.error,
      auth.status,
      { code: auth.status === 503 ? "CONTROL_PLANE_SCHEMA_INCOMPLETE" : undefined }
    )
  }
  const context = auth.context
  const params = new URL(request.url).searchParams
  const parsedDays = rangeSchema.safeParse(params.get("days") || undefined)
  if (!parsedDays.success) {
    return adminFail(context, "Dashboard range is invalid.", 422, {
      code: "INVALID_DATE_RANGE",
    })
  }

  const startedAt = performance.now()
  try {
    const rpcResult = await adminSupabase.rpc("admin_control_plane_dashboard_v2", {
      requesting_admin_id: context.adminUserId,
      range_days: parsedDays.data,
    })
    let sections = normalizeRpcSections(rpcResult.data)

    if (!sections) {
      console.warn("[admin-dashboard-rpc-fallback]", {
        requestId: context.requestId,
        databaseCode: rpcResult.error?.code || "invalid_response",
        databaseMessage: rpcResult.error?.message || "Dashboard v2 response was invalid.",
      })
      sections = await loadIsolatedSections(context.requestId, parsedDays.data)
    }

    const loadTimeMs = Math.round(performance.now() - startedAt)
    console.info("[admin-dashboard]", {
      requestId: context.requestId,
      loadTimeMs,
      sectionStatuses: Object.fromEntries(
        Object.entries(sections).map(([name, section]) => [name, section.status])
      ),
    })

    if (params.get("format") === "csv") {
      return csvResponse(
        `bezgrow-admin-dashboard-${dateText(new Date())}.csv`,
        [
          "date_range",
          "generated_at",
          "metric_name",
          "metric_value",
          "status",
          "source",
          "notes",
        ],
        dashboardCsvRows(sections, parsedDays.data)
      )
    }

    return adminOk(
      context,
      {
        rangeDays: parsedDays.data,
        loadTimeMs,
        sections,
        summary: summaryFromSections(sections),
        revenue: {
          licenseValue: null,
          licenseValueLabel: "Not configured",
          subscriptionRevenue: null,
          subscriptionRevenueLabel: "Payment system not connected",
        },
        dataBoundaries: {
          platform: "Available from the Bezgrow control plane",
          license: "Authoritative cloud metadata with offline-verifiable signed files",
          device: "Last reported during authenticated online contact",
          optionalBackupMetadata: "Available only when a customer explicitly enables the separate backup service",
          localErp: "Customer ERP data is stored locally on the customer’s device and is not available to Bezgrow administrators.",
        },
      },
      {
        headers: {
          "Cache-Control": "private, max-age=15, stale-while-revalidate=30",
        },
      }
    )
  } catch (error) {
    return unexpectedAdminError(context, error, "Platform dashboard failed to load.")
  }
}
