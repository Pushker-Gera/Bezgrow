"use client"

import { useMemo, useState } from "react"
import { apiFetch } from "@/lib/api/client-fetch"
import {
  closeConfirmation,
  financialYearHasStarted,
  formatFinancialYearDate,
  formatFinancialYearStartDate,
  isoLocalDate,
  nextFinancialYear,
  reopenConfirmation,
  type FinancialYear,
  type InvoiceNumberingMode,
} from "@/lib/financial-years"
import { useFinancialYears } from "@/components/financial-years/FinancialYearContext"

type Summary = {
  invoiceCount: number
  revenue: number
  outstandingReceivables: number
  supplierPayables: number
  productCount: number
  customerCount: number
  supplierCount: number
  warehouseCount: number
  closingInventoryQuantity: number
  closingInventorySellingValue: number
  closingInventoryCost: number
  batchCount: number
  gst: number
}

type Checks = { blockers: string[]; warnings: string[]; integrity: { ok: boolean } }

function money(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0))
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init)
  const payload = await response.json() as Record<string, unknown> & { error?: string }
  if (!response.ok) throw new Error(payload.error || "Financial-year operation failed.")
  return payload
}

export function FinancialYearManagement({ organizationId }: { organizationId: string }) {
  const { years, activeYear, selectedYear, selectYear, refresh } = useFinancialYears()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [workflow, setWorkflow] = useState<"create" | "close" | "reopen" | null>(null)
  const [step, setStep] = useState(1)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [checks, setChecks] = useState<Checks | null>(null)
  const [confirmation, setConfirmation] = useState("")
  const [reason, setReason] = useState("")
  const [workflowYear, setWorkflowYear] = useState<FinancialYear | null>(null)

  const today = isoLocalDate()
  const mostRecentEndedYear = years
    .filter((year) => year.end_date < today)
    .sort((left, right) => right.start_date.localeCompare(left.start_date))[0] || null
  const sourceYear = activeYear || mostRecentEndedYear || selectedYear || years[0] || null
  const closingYear = selectedYear?.status === "OPEN" && selectedYear.end_date < today
    ? selectedYear
    : sourceYear?.status === "OPEN" && sourceYear.end_date < today
      ? sourceYear
      : null
  const sourceYearEnded = Boolean(sourceYear && sourceYear.end_date < today)
  const nextYear = useMemo(() => sourceYear ? nextFinancialYear(sourceYear) : null, [sourceYear])
  const nextLabel = nextYear?.label || "Next financial year"
  const nextAvailable = Boolean(nextYear && financialYearHasStarted(nextYear, today))

  async function loadSummary(year: FinancialYear, mode: "create" | "close") {
    setBusy(true)
    setNotice("")
    try {
      const params = new URLSearchParams({ organization_id: organizationId, financial_year_id: year.id })
      const payload = await jsonRequest(`/api/financial-years/summary?${params}`)
      setSummary(payload.summary as Summary)
      if (mode === "close") {
        const checkPayload = await jsonRequest(`/api/financial-years/closing-checks?${params}`)
        setChecks(checkPayload.checks as Checks)
      }
      setWorkflow(mode)
      setWorkflowYear(year)
      setStep(1)
      setConfirmation("")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Summary failed to load.")
    } finally {
      setBusy(false)
    }
  }

  async function createYear() {
    if (!sourceYear) return
    setBusy(true)
    try {
      const payload = await jsonRequest("/api/financial-years/create-next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, source_financial_year_id: sourceYear.id }),
      })
      const year = payload.year as FinancialYear
      await refresh()
      selectYear(year.id)
      setWorkflow(null)
      setNotice(`${year.label} started after a verified safety backup. Stock, batches, costs, expiry dates, warehouses, receivables, and payables were recorded as opening snapshots.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Financial year could not be created.")
    } finally {
      setBusy(false)
    }
  }

  async function closeYear() {
    if (!workflowYear) return
    setBusy(true)
    try {
      await jsonRequest("/api/financial-years/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, financial_year_id: workflowYear.id, confirmation }),
      })
      await refresh()
      setWorkflow(null)
      setNotice(`${workflowYear.label} closed after a verified local safety backup.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Financial year could not be closed.")
    } finally {
      setBusy(false)
    }
  }

  async function reopenYear(year: FinancialYear) {
    setBusy(true)
    try {
      await jsonRequest("/api/financial-years/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, financial_year_id: year.id, confirmation, reason }),
      })
      await refresh()
      setWorkflow(null)
      setNotice(`${year.label} reopened. The reason was recorded in the local audit log.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Financial year could not be reopened.")
    } finally {
      setBusy(false)
    }
  }

  async function updateNumbering(year: FinancialYear, mode: InvoiceNumberingMode) {
    setBusy(true)
    try {
      await jsonRequest("/api/financial-years/numbering", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization_id: organizationId, financial_year_id: year.id, mode }),
      })
      await refresh()
      setNotice(`Invoice numbering for ${year.label} set to ${mode === "RESTART" ? "restart each financial year" : "continue across years"}.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invoice numbering could not be changed.")
    } finally {
      setBusy(false)
    }
  }

  const reopenYearTarget = workflow === "reopen" ? workflowYear : null

  return (
    <section className="rounded-[36px] border border-cyan-400/20 bg-cyan-500/[0.055] p-7 backdrop-blur-2xl" aria-labelledby="financial-years-heading">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Financial Years</p>
          <h2 id="financial-years-heading" className="mt-2 text-3xl font-black">Accounting periods</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-400">April–March by default. Historical years stay inside Bezgrow and remain available without restoring a backup.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sourceYear && nextYear && (
            <div className="text-right">
              <button type="button" disabled={busy || !nextAvailable} onClick={() => void loadSummary(sourceYear, "create")} className="h-11 rounded-xl bg-white px-4 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40">Start {nextLabel}</button>
              {!nextAvailable && <p className="mt-1 text-xs font-bold text-neutral-500">Available from {formatFinancialYearStartDate(nextYear.startDate)}</p>}
            </div>
          )}
          {closingYear && <button type="button" disabled={busy} onClick={() => void loadSummary(closingYear, "close")} className="h-11 rounded-xl border border-amber-300/25 bg-amber-400/10 px-4 text-sm font-black text-amber-100 disabled:opacity-50">Close {closingYear.label}</button>}
        </div>
      </div>

      {notice && <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-black/35 px-4 py-3 text-sm text-cyan-100">{notice}</div>}
      {sourceYearEnded && <div className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm font-bold text-amber-100">{sourceYear.label} has ended. Review it, then start {nextLabel}; no data will be cleared.</div>}

      <div className="mt-6 grid gap-3">
        {years.map((year) => (
          <div key={year.id} className={`rounded-2xl border p-5 ${selectedYear?.id === year.id ? "border-cyan-300/35 bg-cyan-300/10" : "border-white/10 bg-black/35"}`}>
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <button type="button" onClick={() => selectYear(year.id)} className="text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xl font-black">{year.label}</span>
                  {year.is_active && <span className="rounded-full bg-emerald-300 px-2.5 py-1 text-[10px] font-black uppercase text-black">Current active</span>}
                  {year.start_date > today && <span className="rounded-full bg-violet-300/15 px-2.5 py-1 text-[10px] font-black uppercase text-violet-100">Future · unavailable</span>}
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${year.status === "CLOSED" ? "bg-neutral-700 text-neutral-200" : "bg-cyan-300/15 text-cyan-100"}`}>{year.status}</span>
                </div>
                <p className="mt-2 text-sm text-neutral-400">{formatFinancialYearDate(year.start_date)} — {formatFinancialYearDate(year.end_date)}</p>
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <select value={year.invoice_numbering_mode} disabled={busy || year.start_date > today || year.status !== "OPEN" || Number((year as FinancialYear & { invoice_count?: number }).invoice_count || 0) > 0} onChange={(event) => void updateNumbering(year, event.target.value as InvoiceNumberingMode)} className="h-10 rounded-xl border border-white/10 bg-black/60 px-3 text-xs font-bold text-white disabled:opacity-50" aria-label={`Invoice numbering for ${year.label}`}>
                  <option value="CONTINUE">Continue invoice sequence</option>
                  <option value="RESTART">Restart sequence this year</option>
                </select>
                {year.status === "CLOSED" && year.start_date <= today && <button type="button" onClick={() => { setWorkflowYear(year); setWorkflow("reopen"); setConfirmation(""); setReason("") }} className="h-10 rounded-xl border border-amber-300/25 bg-amber-400/10 px-3 text-xs font-black text-amber-100">Reopen</button>}
              </div>
            </div>
          </div>
        ))}
      </div>

      {workflow && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Financial year workflow" onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault() }}>
          <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-white/15 bg-[#080b0b] shadow-2xl">
            <div tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6 outline-none [scrollbar-gutter:stable]" aria-label="Scrollable financial year details">
            {workflow === "create" && sourceYear && summary && (
              <>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Start {nextLabel} · Step {step} of 5</p>
                <h3 className="mt-3 text-3xl font-black">{step === 1 ? "Review previous year" : step === 2 ? "Carry forward" : step === 3 ? "Opening balances" : step === 4 ? "Final review" : "Start financial year"}</h3>
                {step === 1 && <SummaryGrid summary={summary} />}
                {step === 2 && <Checklist rows={["Products, customers, suppliers, and warehouses remain shared master records", `Closing stock: ${summary.closingInventoryQuantity.toLocaleString()} units`, `${summary.batchCount.toLocaleString()} live batches with warehouse, expiry, and purchase cost`, "Business, GST, logo, print, HSN, and product settings remain available"]} />}
                {step === 3 && <Checklist rows={[`Opening inventory: ${money(summary.closingInventoryCost)} at cost`, `Opening receivables: ${money(summary.outstandingReceivables)}`, `Opening payables: ${money(summary.supplierPayables)}`, "Old invoices remain in their original year; revenue and GST are not copied"]} />}
                {step === 4 && <SummaryGrid summary={summary} />}
                {step === 5 && <div className="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-5 text-sm leading-7 text-emerald-50">Bezgrow will first create and verify a local safety backup, then start {nextLabel} in one SQLite transaction. Opening snapshots do not alter physical stock or duplicate sales, tax, invoices, customers, or products.</div>}
                <div className="sticky bottom-0 z-10 -mx-2 mt-6 flex flex-wrap justify-end gap-3 border-t border-white/10 bg-[#080b0b]/95 p-2 pt-4 backdrop-blur"><button type="button" onClick={() => setWorkflow(null)} className="h-11 rounded-xl border border-white/10 px-4 font-bold">Cancel</button>{step > 1 && <button type="button" onClick={() => setStep((value) => value - 1)} className="h-11 rounded-xl border border-white/10 px-4 font-bold">Back</button>}{step < 5 ? <button type="button" onClick={() => setStep((value) => value + 1)} className="h-11 rounded-xl bg-white px-5 font-black text-black">Continue</button> : <button type="button" disabled={busy} onClick={() => void createYear()} className="h-11 rounded-xl bg-emerald-300 px-5 font-black text-black disabled:opacity-50">{busy ? "Starting…" : `Start ${nextLabel}`}</button>}</div>
              </>
            )}
            {workflow === "close" && workflowYear && summary && checks && (
              <>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-200">Financial year closing</p><h3 className="mt-3 text-3xl font-black">Close {workflowYear.label}</h3><SummaryGrid summary={summary} />
                {checks.blockers.length > 0 && <MessageList title="Blockers" rows={checks.blockers} tone="red" />}{checks.warnings.length > 0 && <MessageList title="Warnings" rows={checks.warnings} tone="amber" />}
                <p className="mt-5 text-sm leading-6 text-neutral-300">A local safety backup is mandatory. Type <strong>{closeConfirmation(workflowYear)}</strong>. Pressing Enter never confirms closing.</p>
                <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={closeConfirmation(workflowYear)} className="mt-3 h-12 w-full rounded-xl border border-amber-300/25 bg-black px-4 font-bold outline-none" />
                <div className="sticky bottom-0 z-10 -mx-2 mt-5 flex flex-wrap justify-end gap-3 border-t border-white/10 bg-[#080b0b]/95 p-2 pt-4 backdrop-blur"><button type="button" onClick={() => setWorkflow(null)} className="h-11 rounded-xl border border-white/10 px-4 font-bold">Cancel</button><button type="button" disabled={busy || checks.blockers.length > 0 || confirmation.trim().toUpperCase() !== closeConfirmation(workflowYear)} onClick={() => void closeYear()} className="h-11 rounded-xl bg-amber-300 px-5 font-black text-black disabled:opacity-40">{busy ? "Backing up…" : "Create backup and close"}</button></div>
              </>
            )}
            {workflow === "reopen" && reopenYearTarget && (
              <>
                <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-200">Controlled reopening</p><h3 className="mt-3 text-3xl font-black">Reopen {reopenYearTarget.label}</h3><p className="mt-4 text-sm leading-6 text-neutral-300">Reopening changes the finalisation state for audit review; it never makes a historical year operational or permits new historical postings. The date, reason, and action are recorded locally. Type <strong>{reopenConfirmation(reopenYearTarget)}</strong>.</p>
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for reopening (required)" className="mt-4 min-h-24 w-full rounded-xl border border-white/10 bg-black p-4 outline-none" />
                <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={reopenConfirmation(reopenYearTarget)} className="mt-3 h-12 w-full rounded-xl border border-amber-300/25 bg-black px-4 font-bold outline-none" />
                <div className="sticky bottom-0 z-10 -mx-2 mt-5 flex flex-wrap justify-end gap-3 border-t border-white/10 bg-[#080b0b]/95 p-2 pt-4 backdrop-blur"><button type="button" onClick={() => setWorkflow(null)} className="h-11 rounded-xl border border-white/10 px-4 font-bold">Cancel</button><button type="button" disabled={busy || reason.trim().length < 10 || confirmation.trim().toUpperCase() !== reopenConfirmation(reopenYearTarget)} onClick={() => void reopenYear(reopenYearTarget)} className="h-11 rounded-xl bg-amber-300 px-5 font-black text-black disabled:opacity-40">{busy ? "Reopening…" : "Reopen financial year"}</button></div>
              </>
            )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function SummaryGrid({ summary }: { summary: Summary }) {
  const rows = [["Invoices", summary.invoiceCount.toLocaleString()], ["Revenue", money(summary.revenue)], ["GST", money(summary.gst)], ["Receivables", money(summary.outstandingReceivables)], ["Stock cost", money(summary.closingInventoryCost)], ["Stock quantity", summary.closingInventoryQuantity.toLocaleString()], ["Customers", summary.customerCount.toLocaleString()], ["Suppliers", summary.supplierCount.toLocaleString()]]
  return <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">{rows.map(([label, value]) => <div key={label} className="rounded-xl border border-white/10 bg-white/[0.04] p-4"><p className="text-xs uppercase tracking-wider text-neutral-500">{label}</p><p className="mt-2 font-black">{value}</p></div>)}</div>
}

function Checklist({ rows }: { rows: string[] }) { return <div className="mt-5 space-y-3">{rows.map((row) => <div key={row} className="rounded-xl border border-emerald-300/15 bg-emerald-400/[0.06] p-4 text-sm text-emerald-50">✓ {row}</div>)}</div> }
function MessageList({ title, rows, tone }: { title: string; rows: string[]; tone: "red" | "amber" }) { return <div className={`mt-4 rounded-xl border p-4 ${tone === "red" ? "border-red-300/20 bg-red-400/10 text-red-100" : "border-amber-300/20 bg-amber-400/10 text-amber-100"}`}><p className="font-black">{title}</p><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{rows.map((row) => <li key={row}>{row}</li>)}</ul></div> }
