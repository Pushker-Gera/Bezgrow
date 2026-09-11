"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import PlatformAdminLauncher from "@/components/desktop/PlatformAdminLauncher"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { localLicenseSnapshot, revalidateLocalLicenseWithControlPlane } from "@/lib/offline/local/license"
import { getLocalDatabaseService } from "@/lib/offline/local/service"
import { canContinueReadOnly } from "@/lib/startup/state-machine"

type SubscriptionView = {
  status: string; reason: string; plan: string; trialEndsAt: string; validUntil: string; licenseId: string; allowed: boolean
  amountMinor: number | null; currency: string
}

export default function SubscriptionPage() {
  const router = useRouter()
  const [view, setView] = useState<SubscriptionView | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")

  async function load(remote = false) {
    setRefreshing(remote); setError("")
    try {
      const snapshot = remote ? (await revalidateLocalLicenseWithControlPlane()).snapshot : await localLicenseSnapshot()
      const license = snapshot.license as Record<string, unknown> | null | undefined
      const businessId = String(license?.business_id || "")
      const planRows = businessId ? await getLocalDatabaseService().select<Record<string, unknown>>(
        "SELECT key, value_text FROM business_settings WHERE organization_id = ? AND key IN ('subscription_plan_name','subscription_amount_minor','subscription_currency')",
        [businessId],
      ).catch(() => []) : []
      const planSettings = Object.fromEntries(planRows.map((row) => [String(row.key || ""), String(row.value_text || "")]))
      const rawAmountMinor = planSettings.subscription_amount_minor?.trim()
      const amountMinor = rawAmountMinor ? Number(rawAmountMinor) : Number.NaN
      setView({
        status: snapshot.status,
        reason: snapshot.reason,
        plan: planSettings.subscription_plan_name || String(license?.plan_name || "Bezgrow"),
        trialEndsAt: String(license?.trial_ends_at || ""), validUntil: String(license?.valid_until || snapshot.expiresAt || ""),
        licenseId: String(license?.id || ""), allowed: snapshot.allowed,
        amountMinor: Number.isFinite(amountMinor) && amountMinor >= 0 ? amountMinor : null,
        currency: planSettings.subscription_currency || "INR",
      })
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Subscription details could not be loaded.") }
    finally { setRefreshing(false) }
  }

  useEffect(() => { void isTauriRuntimeAsync().then((desktop) => desktop ? load() : router.replace("/download?erp=desktop_local_only")) }, [router])
  const deadline = view?.trialEndsAt || view?.validUntil
  const days = deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 86_400_000)) : 0
  const readOnlyEligible = view ? canContinueReadOnly(view.status as Parameters<typeof canContinueReadOnly>[0]) : false
  const price = view?.amountMinor === null || view?.amountMinor === undefined
    ? null
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: view.currency, maximumFractionDigits: 0 }).format(view.amountMinor / 100)

  function continueReadOnly() {
    if (view?.licenseId) sessionStorage.setItem(`bezgrow:read-only:${view.licenseId}`, "1")
    const next = new URLSearchParams(window.location.search).get("next")
    router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard")
  }

  return <main className="flex min-h-dvh items-center justify-center bg-[#020505] px-5 py-10 text-white"><section className="w-full max-w-2xl rounded-[34px] border border-white/10 bg-white/[0.04] p-7 shadow-2xl sm:p-10">
    <div className="flex items-center gap-4"><BezgrowLogoMark className="h-14 w-14" size={56} /><div><p className="text-xl font-black">Bezgrow</p><p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Subscription</p></div></div>
    {!view ? <div className="py-12 text-center"><p className="text-neutral-400">Checking the signed local entitlement…</p>{error && <p role="alert" className="mt-4 text-sm text-red-200">{error}</p>}<Link href="/offline?mode=legacy" className="mx-auto mt-6 flex min-h-12 max-w-xs items-center justify-center rounded-2xl border border-white/15 font-black">Open recovery</Link><PlatformAdminLauncher className="mx-auto mt-3 max-w-xs" /></div> : <>
      <div className="mt-8 flex flex-wrap items-end justify-between gap-5"><div><p className="text-xs font-black uppercase tracking-[0.18em] text-neutral-500">{view.plan}</p><h1 className="mt-2 text-4xl font-black">{view.allowed ? (view.status.includes("offline") ? "Trial active offline" : "Trial active") : view.status === "expired" ? "Trial expired" : "Subscription inactive"}</h1></div><div className="text-right"><p className="text-3xl font-black">{price || "—"}</p><p className="text-sm text-neutral-500">per month after trial</p></div></div>
      <div className={`mt-7 rounded-2xl border p-5 ${view.allowed ? "border-emerald-300/20 bg-emerald-300/[0.06]" : "border-amber-300/20 bg-amber-300/[0.07]"}`}><p className="font-black">{view.allowed ? `${days} day${days === 1 ? "" : "s"} remaining` : "Read-only protection is active"}</p><p className="mt-2 text-sm leading-6 text-neutral-300">{view.reason}</p>{deadline && <p className="mt-2 text-xs text-neutral-500">Signed access deadline: {new Date(deadline).toLocaleString("en-IN")}</p>}</div>
      <div className="mt-7 rounded-2xl border border-white/10 bg-black/30 p-5"><p className="font-black">Subscription setup</p><p className="mt-2 text-sm leading-6 text-neutral-400">Online payment is not available in this release. No card, UPI, or bank details are collected here. Your local business records remain available for viewing and backup after trial expiry.</p></div>
      {error && <p role="alert" className="mt-5 text-sm text-red-200">{error}</p>}
      <div className="mt-7 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => void load(true)} disabled={refreshing} className="min-h-12 rounded-2xl bg-cyan-300 px-5 font-black text-black disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh entitlement"}</button>{view.allowed ? <Link href="/dashboard" className="flex min-h-12 items-center justify-center rounded-2xl border border-white/15 font-black">Open dashboard</Link> : readOnlyEligible ? <button type="button" onClick={continueReadOnly} className="min-h-12 rounded-2xl border border-white/15 px-5 font-black">Continue read-only</button> : <Link href="/offline?mode=legacy" className="flex min-h-12 items-center justify-center rounded-2xl border border-white/15 px-5 font-black">Open recovery</Link>}</div>
      <PlatformAdminLauncher className="mt-3" />
      <p className="mt-5 text-center text-xs text-neutral-500">Need help? Contact support with the Device ID shown in Settings. Your local ERP records are not deleted when access expires.</p>
    </>}
  </section></main>
}
