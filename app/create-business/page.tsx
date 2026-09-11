"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import PlatformAdminLauncher from "@/components/desktop/PlatformAdminLauncher"
import { desktopArchitecture, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { createLocalAppPassword, getAppLockStatus } from "@/lib/app-lock/client"
import { nativeOnboardingProofHeaders } from "@/lib/device/native-proof-client"
import { getOrCreateDeviceId } from "@/lib/offline/local/license"
import {
  installOnboardingEntitlement,
  markOnboardingComplete,
  pendingLocalOnboarding,
  recordOnboardingFailure,
  stageLocalBusiness,
  type OnboardingControlPlaneResult,
} from "@/lib/onboarding/local"
import { onboardingValidationMessage, phase1BusinessOnboardingSchema } from "@/lib/onboarding/validation"
import packageJson from "@/package.json"

const STEPS = ["Owner", "Business", "Address", "Accounting", "Review"]
const BUSINESS_TYPES = ["Proprietorship", "Partnership", "LLP", "Private Limited", "Public Limited", "Trust / Society", "Other"]
const INDIA_STATES = [
  "Andhra Pradesh", "Assam", "Bihar", "Chhattisgarh", "Delhi", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
  "Maharashtra", "Odisha", "Punjab", "Rajasthan", "Tamil Nadu", "Telangana", "Uttar Pradesh",
  "Uttarakhand", "West Bengal", "Other",
]

type FormState = {
  localBusinessId: string; idempotencyKey: string; ownerName: string; email: string; mobile: string; password: string
  businessName: string; businessType: string; industry: string; gstRegistered: boolean; gstin: string; pan: string
  address: string; city: string; state: string; postalCode: string; financialYearStartMonth: number; invoicePrefix: string
  deviceId: string; platform: "macos" | "windows"; architecture: "arm64" | "x86_64"; appVersion: string; termsAccepted: true
}

function initialForm(): FormState {
  return {
    localBusinessId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ownerName: "", email: "", mobile: "", password: "",
    businessName: "", businessType: "Proprietorship", industry: "Retail", gstRegistered: false, gstin: "", pan: "",
    address: "", city: "", state: "", postalCode: "", financialYearStartMonth: 4, invoicePrefix: "INV", deviceId: "",
    platform: /windows/i.test(`${navigator.platform} ${navigator.userAgent}`) ? "windows" : "macos",
    architecture: desktopArchitecture() === "arm64" ? "arm64" : "x86_64", appVersion: packageJson.version, termsAccepted: true,
  }
}

function Field({ label, value, onChange, type = "text", placeholder, autoComplete, error }: {
  label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; autoComplete?: string; error?: string
}) {
  const id = `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return <label className="block text-sm font-bold" htmlFor={id}>{label}<input id={id} type={type} value={value} placeholder={placeholder} autoComplete={autoComplete} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => onChange(event.target.value)} className={`mt-2 h-14 w-full rounded-2xl border bg-black/50 px-4 font-medium text-white outline-none transition focus:border-cyan-300/60 ${error ? "border-red-400/60" : "border-white/10"}`} />{error && <span id={`${id}-error`} className="mt-2 block text-xs leading-5 text-red-200">{error}</span>}</label>
}

export default function CreateBusinessPage() {
  const router = useRouter()
  const [form, setForm] = useState<FormState | null>(null)
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [controlPlane, setControlPlane] = useState<OnboardingControlPlaneResult | null>(null)
  const [appPassword, setAppPassword] = useState("")
  const [appPasswordConfirmation, setAppPasswordConfirmation] = useState("")
  const [showWelcome, setShowWelcome] = useState(true)
  const [resuming, setResuming] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormState, string>>>({})

  useEffect(() => {
    let active = true
    void (async () => {
      if (!(await isTauriRuntimeAsync().catch(() => false))) return router.replace("/download?erp=desktop_local_only")
      const [deviceId, pending] = await Promise.all([getOrCreateDeviceId(), pendingLocalOnboarding().catch(() => null)])
      if (!active) return
      const base = initialForm()
      if (pending) {
        try {
          const recovered = JSON.parse(pending.request_json) as Partial<FormState>
          setForm({ ...base, ...recovered, password: "", deviceId })
          setNotice("Your local business is safe. Re-enter the account password to resume online trial setup.")
          setShowWelcome(false)
          setResuming(true)
          setStep(4)
          return
        } catch { /* Keep the local attempt and show a fresh form shell. */ }
      }
      setForm({ ...base, deviceId })
    })()
    return () => { active = false }
  }, [router])

  const review = useMemo(() => form ? [
    ["Owner", form.ownerName], ["Account", form.email], ["Business", form.businessName], ["Type", form.businessType],
    ["GST", form.gstRegistered ? form.gstin : "Not registered"], ["Location", `${form.city}, ${form.state} ${form.postalCode}`],
    ["Financial year", `Starts in month ${form.financialYearStartMonth}`], ["Invoice prefix", form.invoicePrefix],
  ] : [], [form])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current)
    setFieldErrors((current) => ({ ...current, [key]: undefined }))
  }

  function validateStep() {
    if (!form) return false
    const keys = ([
      ["ownerName", "email", "mobile", "password"],
      ["businessName", "businessType", "industry", "gstin", "pan"],
      ["address", "city", "state", "postalCode"],
      ["financialYearStartMonth", "invoicePrefix"],
    ][step] || []) as Array<keyof FormState>
    const parsed = phase1BusinessOnboardingSchema.safeParse(form)
    const currentErrors: Partial<Record<keyof FormState, string>> = {}
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormState
        if (keys.includes(key) && !currentErrors[key]) currentErrors[key] = issue.message
      }
    }
    setFieldErrors(currentErrors)
    if (Object.keys(currentErrors).length) { setError("Review the highlighted details before continuing."); return false }
    setError("")
    return true
  }

  async function createBusiness(event: FormEvent) {
    event.preventDefault()
    if (!form) return
    const parsed = phase1BusinessOnboardingSchema.safeParse(form)
    if (!parsed.success) {
      const errors: Partial<Record<keyof FormState, string>> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof FormState
        if (!errors[key]) errors[key] = issue.message
      }
      setFieldErrors(errors)
      setError(onboardingValidationMessage(parsed.error))
      return
    }
    setSubmitting(true); setError("")
    try {
      await stageLocalBusiness(parsed.data)
      setNotice("Local business created. Creating the server-authoritative 30-day trial…")
      const body = JSON.stringify(parsed.data)
      const proofHeaders = await nativeOnboardingProofHeaders(body)
      const response = await fetch(`/api/desktop-proxy?path=${encodeURIComponent("/api/entitlements/onboard")}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": parsed.data.idempotencyKey, ...proofHeaders },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      })
      const payload = await response.json().catch(() => null) as ({ success?: boolean; error?: string; code?: string } & OnboardingControlPlaneResult) | null
      if (!response.ok || !payload?.success) throw new Error(payload?.error || "Trial setup could not reach Bezgrow.")
      await installOnboardingEntitlement(payload)
      const existingAppLock = await getAppLockStatus().catch(() => null)
      if (existingAppLock?.enabled) {
        if (existingAppLock.businessId !== form.localBusinessId) {
          throw new Error("This device already has App Lock for another business. Use recovery or contact support before continuing.")
        }
        await markOnboardingComplete(form.localBusinessId)
        router.replace("/dashboard?welcome=1")
        return
      }
      setControlPlane(payload)
      setNotice(payload.account.emailVerified
        ? "Trial entitlement installed. Choose the separate App Password for this device."
        : "Trial entitlement installed. Bezgrow has not verified ownership of this email, so keep the account password safe for recovery. Choose the separate App Password for this device.")
      setStep(STEPS.length)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Business setup could not be completed."
      await recordOnboardingFailure(parsed.data.idempotencyKey, message).catch(() => undefined)
      setError(message.startsWith("Check your email and confirm")
        ? message
        : `${message} Check your internet connection and retry. Your local business data has not been deleted.`)
    } finally { setSubmitting(false) }
  }

  async function finishAppLock(event: FormEvent) {
    event.preventDefault()
    if (!form || !controlPlane) return
    if (appPassword !== appPasswordConfirmation) { setError("App Passwords do not match."); return }
    setSubmitting(true); setError("")
    try {
      await createLocalAppPassword({ password: appPassword, deviceId: form.deviceId, licenseId: controlPlane.entitlement.id, businessId: form.localBusinessId })
      await markOnboardingComplete(form.localBusinessId)
      router.replace("/dashboard?welcome=1")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "App Lock setup failed.") }
    finally { setSubmitting(false) }
  }

  if (!form) return <main className="flex min-h-dvh items-center justify-center bg-black text-neutral-300">Preparing secure local setup…</main>

  if (showWelcome) return <main className="flex min-h-dvh items-center justify-center bg-[#020505] px-5 py-10 text-white"><section className="w-full max-w-3xl rounded-[36px] border border-white/10 bg-white/[0.04] p-7 text-center shadow-[0_32px_120px_rgba(0,0,0,0.6)] sm:p-12"><BezgrowLogoMark className="mx-auto h-20 w-20" size={80} priority /><p className="mt-7 text-xs font-black uppercase tracking-[0.24em] text-cyan-200">Welcome to Bezgrow</p><h1 className="mt-3 text-4xl font-black tracking-tight sm:text-6xl">Your business starts here.</h1><p className="mx-auto mt-5 max-w-xl text-base leading-7 text-neutral-400">Create a local-first workspace and start your server-authoritative 30-day free trial. Your ERP records stay on this computer.</p><button type="button" onClick={() => setShowWelcome(false)} className="mt-8 min-h-14 w-full rounded-2xl bg-cyan-300 px-7 text-sm font-black uppercase tracking-[0.12em] text-black sm:w-auto">Create your business</button><div className="mx-auto mt-7 grid max-w-xl gap-3 sm:grid-cols-2"><Link href="/login?recover=1" className="flex min-h-12 items-center justify-center rounded-2xl border border-white/15 px-4 text-sm font-bold">Already have a business</Link><Link href="/offline?mode=legacy" className="flex min-h-12 items-center justify-center rounded-2xl border border-white/15 px-4 text-sm font-bold">Restore backup or licence</Link></div><PlatformAdminLauncher className="mx-auto mt-3 max-w-xl" /></section></main>

  return <main className="min-h-dvh bg-[#020505] px-4 py-6 text-white sm:px-8 sm:py-10"><div className="mx-auto max-w-5xl">
    <header className="flex items-center justify-between gap-4"><div className="flex items-center gap-3"><BezgrowLogoMark className="h-12 w-12" size={48} /><div><p className="text-xl font-black">Bezgrow</p><p className="text-xs uppercase tracking-[0.18em] text-cyan-200">Local-first business setup</p></div></div><Link href="/offline?mode=legacy" className="text-sm font-bold text-neutral-400 hover:text-white">Existing licence or backup</Link></header>
    <section className="mt-8 overflow-hidden rounded-[34px] border border-white/10 bg-white/[0.035] shadow-[0_32px_120px_rgba(0,0,0,0.55)]"><div className="grid lg:grid-cols-[300px_1fr]">
      <aside className="border-b border-white/10 bg-cyan-300/[0.055] p-7 lg:border-b-0 lg:border-r"><p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">30-day free trial</p><h1 className="mt-4 text-3xl font-black leading-tight">Build the business locally. Keep the data yours.</h1><p className="mt-4 text-sm leading-6 text-neutral-400">Account, subscription, entitlement, and device metadata are stored online. Products, parties, invoices, stock, and accounting remain in SQLite on this device.</p><div className="mt-7 rounded-2xl border border-white/10 bg-black/30 p-4"><p className="text-2xl font-black">₹200<span className="text-sm text-neutral-400"> / month</span></p><p className="mt-1 text-xs leading-5 text-neutral-500">After the trial. No payment is collected in Phase 1; checkout arrives in Phase 2.</p></div><ol className="mt-7 grid grid-cols-5 gap-2 lg:grid-cols-1">{STEPS.map((label, index) => <li key={label} className={`rounded-xl px-3 py-2 text-xs font-black ${index === step ? "bg-cyan-300 text-black" : index < step ? "bg-cyan-300/10 text-cyan-100" : "text-neutral-600"}`}>{index + 1}. <span className="hidden lg:inline">{label}</span></li>)}</ol></aside>
      <div className="p-6 sm:p-9">{notice && <p role="status" className="mb-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.06] px-4 py-3 text-sm leading-6 text-cyan-100">{notice}</p>}
        {step < STEPS.length ? <form onSubmit={createBusiness}><p className="text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Step {step + 1} of {STEPS.length}</p><h2 className="mt-2 text-3xl font-black">{STEPS[step]} details</h2><div className="mt-7 grid gap-5 sm:grid-cols-2">
          {step === 0 && <><Field label="Owner name" value={form.ownerName} error={fieldErrors.ownerName} onChange={(value) => update("ownerName", value)} autoComplete="name" /><Field label="Mobile" value={form.mobile} error={fieldErrors.mobile} onChange={(value) => update("mobile", value)} placeholder="10-digit Indian mobile" autoComplete="tel" /><Field label="Email" type="email" value={form.email} error={fieldErrors.email} onChange={(value) => update("email", value)} autoComplete="email" /><Field label="Account password" type="password" value={form.password} error={fieldErrors.password} onChange={(value) => update("password", value)} autoComplete="new-password" /></>}
          {step === 1 && <><Field label="Business name" value={form.businessName} error={fieldErrors.businessName} onChange={(value) => update("businessName", value)} /><label className="block text-sm font-bold">Business type<select value={form.businessType} onChange={(event) => update("businessType", event.target.value)} className="mt-2 h-14 w-full rounded-2xl border border-white/10 bg-black px-4">{BUSINESS_TYPES.map((value) => <option key={value}>{value}</option>)}</select></label><Field label="Industry" value={form.industry} error={fieldErrors.industry} onChange={(value) => update("industry", value)} /><label className="flex min-h-14 items-center gap-3 rounded-2xl border border-white/10 bg-black/40 px-4 text-sm font-bold"><input type="checkbox" checked={form.gstRegistered} onChange={(event) => update("gstRegistered", event.target.checked)} /> GST registered</label>{form.gstRegistered && <Field label="GSTIN" value={form.gstin} error={fieldErrors.gstin} onChange={(value) => update("gstin", value.toUpperCase())} />}<Field label="PAN (optional)" value={form.pan} error={fieldErrors.pan} onChange={(value) => update("pan", value.toUpperCase())} /></>}
          {step === 2 && <><div className="sm:col-span-2"><Field label="Address" value={form.address} error={fieldErrors.address} onChange={(value) => update("address", value)} autoComplete="street-address" /></div><Field label="City" value={form.city} error={fieldErrors.city} onChange={(value) => update("city", value)} /><label className="block text-sm font-bold">State<select value={form.state} onChange={(event) => update("state", event.target.value)} className={`mt-2 h-14 w-full rounded-2xl border bg-black px-4 ${fieldErrors.state ? "border-red-400/60" : "border-white/10"}`}><option value="">Select state</option>{INDIA_STATES.map((value) => <option key={value}>{value}</option>)}</select>{fieldErrors.state && <span className="mt-2 block text-xs text-red-200">{fieldErrors.state}</span>}</label><Field label="PIN code" value={form.postalCode} error={fieldErrors.postalCode} onChange={(value) => update("postalCode", value)} autoComplete="postal-code" /></>}
          {step === 3 && <><label className="block text-sm font-bold">Financial year starts<select value={form.financialYearStartMonth} onChange={(event) => update("financialYearStartMonth", Number(event.target.value))} className="mt-2 h-14 w-full rounded-2xl border border-white/10 bg-black px-4">{Array.from({ length: 12 }, (_, index) => <option value={index + 1} key={index + 1}>{new Intl.DateTimeFormat("en-IN", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, index, 1)))}</option>)}</select></label><Field label="Invoice prefix" value={form.invoicePrefix} error={fieldErrors.invoicePrefix} onChange={(value) => update("invoicePrefix", value.toUpperCase())} /><div className="sm:col-span-2 rounded-2xl border border-white/10 bg-black/30 p-5 text-sm leading-6 text-neutral-400">Bezgrow will create the current financial year, invoice numbering, a complete system chart of accounts, voucher series, fixed-asset categories, and GST/statutory placeholders. The new business starts empty and internally balanced.</div></>}
          {step === 4 && <div className="sm:col-span-2 grid gap-3">{review.map(([label, value]) => <div key={label} className="flex justify-between gap-6 rounded-xl border border-white/10 px-4 py-3 text-sm"><span className="text-neutral-500">{label}</span><span className="text-right font-bold">{value}</span></div>)}{resuming && <div className="mt-3"><Field label="Account password" type="password" value={form.password} error={fieldErrors.password} onChange={(value) => update("password", value)} autoComplete="current-password" /></div>}<p className="mt-3 text-xs leading-5 text-neutral-500">By creating the business you accept the Terms and Privacy Policy. The 30-day period begins only when Bezgrow’s server records the trial.</p></div>}
        </div>{error && <p role="alert" className="mt-5 text-sm leading-6 text-red-200">{error}</p>}<div className="mt-8 flex items-center justify-between gap-3">{!resuming ? <button type="button" disabled={step === 0 || submitting} onClick={() => { setError(""); setStep((value) => value - 1) }} className="min-h-12 rounded-2xl border border-white/15 px-6 font-black disabled:opacity-30">Back</button> : <span className="text-xs leading-5 text-neutral-500">Saved business details are locked while setup resumes.</span>}{step < STEPS.length - 1 ? <button type="button" onClick={() => validateStep() && setStep((value) => value + 1)} className="min-h-12 rounded-2xl bg-white px-7 font-black text-black">Continue</button> : <button type="submit" disabled={submitting} className="min-h-12 rounded-2xl bg-cyan-300 px-7 font-black text-black disabled:opacity-50">{submitting ? "Creating safely…" : resuming ? "Resume trial setup" : "Create business & start trial"}</button>}</div></form>
        : <form onSubmit={finishAppLock}><p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Final security step</p><h2 className="mt-3 text-3xl font-black">Choose your App Password</h2><p className="mt-4 max-w-xl text-sm leading-6 text-neutral-400">This unlocks Bezgrow on this device. It is independent from the account password and from the trial, and stays in the operating system credential store.</p><div className="mt-7 grid gap-5 sm:grid-cols-2"><Field label="App Password" type="password" value={appPassword} onChange={setAppPassword} autoComplete="new-password" /><Field label="Confirm App Password" type="password" value={appPasswordConfirmation} onChange={setAppPasswordConfirmation} autoComplete="new-password" /></div><p className="mt-3 text-xs text-neutral-500">At least 6 characters; numbers only or letters with at least one number.</p>{error && <p role="alert" className="mt-5 text-sm text-red-200">{error}</p>}<button type="submit" disabled={submitting} className="mt-7 min-h-14 w-full rounded-2xl bg-cyan-300 px-7 font-black text-black disabled:opacity-50">{submitting ? "Securing workspace…" : "Finish and open Bezgrow"}</button></form>}
      </div>
    </div></section>
  </div></main>
}
