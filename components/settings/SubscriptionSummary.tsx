"use client"

import { useEffect, useState } from "react"
import { getEntitlementCapabilities, type EntitlementCapabilities } from "@/lib/entitlements/service"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

type Summary = EntitlementCapabilities & {
  planName: string
  amountMinor: number | null
  currency: string
}

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleString("en-IN") : "Not available"
}

export default function SubscriptionSummary({ organizationId }: { organizationId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null)

  useEffect(() => {
    if (!organizationId) return
    let active = true
    void (async () => {
      const [capabilities, rows] = await Promise.all([
        getEntitlementCapabilities(organizationId),
        getLocalDatabaseService().select<Record<string, unknown>>(
          "SELECT key, value_text FROM business_settings WHERE organization_id = ? AND key IN ('subscription_plan_name','subscription_amount_minor','subscription_currency')",
          [organizationId],
        ).catch(() => []),
      ])
      if (!active) return
      const settings = Object.fromEntries(rows.map((row) => [String(row.key || ""), String(row.value_text || "")]))
      const rawAmountMinor = settings.subscription_amount_minor?.trim()
      const amountMinor = rawAmountMinor ? Number(rawAmountMinor) : Number.NaN
      setSummary({
        ...capabilities,
        planName: settings.subscription_plan_name || "Bezgrow",
        amountMinor: Number.isFinite(amountMinor) && amountMinor >= 0 ? amountMinor : null,
        currency: settings.subscription_currency || "INR",
      })
    })().catch(() => { if (active) setSummary(null) })
    return () => { active = false }
  }, [organizationId])

  if (!summary) return <p className="mt-2 text-sm text-neutral-400">Loading signed entitlement details…</p>
  const price = summary.amountMinor === null
    ? "Plan price unavailable"
    : `${new Intl.NumberFormat("en-IN", { style: "currency", currency: summary.currency, maximumFractionDigits: 0 }).format(summary.amountMinor / 100)}/month`

  return <div><h2 className="mt-2 text-2xl font-black">{summary.planName} · {price}</h2><div className="mt-3 grid gap-x-8 gap-y-1 text-sm leading-6 text-neutral-400 sm:grid-cols-2"><p>Status: <span className="font-bold text-white">{summary.status.replaceAll("_", " ")}</span></p><p>Days remaining: <span className="font-bold text-white">{summary.daysRemaining}</span></p><p>Trial started: {dateLabel(summary.trialStartedAt)}</p><p>Trial ends: {dateLabel(summary.trialEndsAt || summary.validUntil)}</p></div></div>
}
