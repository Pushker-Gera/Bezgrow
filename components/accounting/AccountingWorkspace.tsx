"use client"

import Link from "next/link"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { apiFetch } from "@/lib/api/client-fetch"
import { getOrganizationId } from "@/lib/getOrganization"
import { useFinancialYears } from "@/components/financial-years/FinancialYearContext"

type Row = Record<string, unknown>
type Report = Row & { rows?: Row[]; entries?: Row[]; integrity?: Row }

export const accountingViews = [
  { id: "overview", label: "Overview" },
  { id: "chart-of-accounts", label: "Chart of Accounts" },
  { id: "journal", label: "Journal / Vouchers" },
  { id: "general-ledger", label: "General Ledger" },
  { id: "trial-balance", label: "Trial Balance" },
  { id: "profit-loss", label: "Profit & Loss" },
  { id: "balance-sheet", label: "Balance Sheet" },
  { id: "cash-flow", label: "Cash Flow" },
  { id: "expenses", label: "Expenses" },
  { id: "opening-balances", label: "Opening Balances" },
] as const

const reportForView: Record<string, string> = {
  overview: "overview",
  journal: "journals",
  "general-ledger": "general-ledger",
  "trial-balance": "trial-balance",
  "profit-loss": "profit-loss",
  "balance-sheet": "balance-sheet",
  "cash-flow": "cash-flow",
  expenses: "expenses",
  "opening-balances": "warnings",
}

function text(value: unknown, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value)
}

function number(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function moneyMinor(value: unknown) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(number(value) / 100)
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ")
}

async function payload(response: Response) {
  const result = await response.json() as Row
  if (!response.ok || result.success === false) throw new Error(text(result.error, "Accounting request failed."))
  return result
}

function csvValue(value: unknown) {
  const candidate = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)
  return `"${candidate.replaceAll('"', '""')}"`
}

function downloadCsv(name: string, rows: Row[]) {
  if (!rows.length) return
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))))
  const content = [columns.map(csvValue).join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\n")
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${name}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function Metric({ label, value, tone = "cyan" }: { label: string; value: string; tone?: "cyan" | "green" | "amber" }) {
  const styles = { cyan: "border-cyan-400/20 bg-cyan-400/5 text-cyan-100", green: "border-emerald-400/20 bg-emerald-400/5 text-emerald-100", amber: "border-amber-400/20 bg-amber-400/5 text-amber-100" }
  return (
    <article className={`rounded-lg border p-4 ${styles[tone]}`}>
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-white/45">{label}</p>
      <p className="mt-2 text-xl font-black sm:text-2xl">{value}</p>
    </article>
  )
}

function DataTable({ rows, columns, empty = "No posted accounting rows in this period." }: { rows: Row[]; columns: Array<{ key: string; label: string; money?: boolean }>; empty?: string }) {
  if (!rows.length) return <div className="rounded-lg border border-dashed border-white/15 p-8 text-center text-sm text-neutral-500">{empty}</div>
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-white/[0.05] text-[11px] uppercase tracking-[0.12em] text-neutral-500">
            <tr>{columns.map((column) => <th key={column.key} className="whitespace-nowrap px-4 py-3 font-black">{column.label}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {rows.map((row, index) => (
              <tr key={text(row.id, String(index))} className="bg-black/20 hover:bg-white/[0.025]">
                {columns.map((column) => <td key={column.key} className={classNames("whitespace-nowrap px-4 py-3", column.money && "font-mono font-bold")}>{column.money ? moneyMinor(row[column.key]) : text(row[column.key])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-white/10 md:hidden">
        {rows.map((row, index) => (
          <article key={text(row.id, String(index))} className="space-y-2 p-4">
            {columns.map((column) => <div key={column.key} className="flex items-start justify-between gap-4 text-sm"><span className="text-neutral-500">{column.label}</span><span className={classNames("text-right font-bold", column.money && "font-mono")}>{column.money ? moneyMinor(row[column.key]) : text(row[column.key])}</span></div>)}
          </article>
        ))}
      </div>
    </div>
  )
}

function ReportActions({ view, rows }: { view: string; rows: Row[] }) {
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      <button type="button" onClick={() => downloadCsv(`bezgrow-${view}`, rows)} disabled={!rows.length} className="min-h-10 rounded-xl border border-white/10 px-4 text-xs font-black text-neutral-200 disabled:opacity-40">Export CSV</button>
      <button type="button" onClick={() => window.print()} className="min-h-10 rounded-xl border border-white/10 px-4 text-xs font-black text-neutral-200">Print</button>
    </div>
  )
}

export function AccountingWorkspace({ view }: { view: string }) {
  const { selectedYear } = useFinancialYears()
  const [organizationId, setOrganizationId] = useState("")
  const [accounts, setAccounts] = useState<Row[]>([])
  const [status, setStatus] = useState<Row | null>(null)
  const [report, setReport] = useState<Report>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [ledgerAccountId, setLedgerAccountId] = useState("")
  const [expandedVoucher, setExpandedVoucher] = useState("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [transactionType, setTransactionType] = useState("all")
  const [direction, setDirection] = useState<"asc" | "desc">("asc")
  const [reportPage, setReportPage] = useState(1)
  const [reportSearch, setReportSearch] = useState("")
  const [searchDraft, setSearchDraft] = useState("")

  async function load() {
    if (!selectedYear) return
    setLoading(true)
    try {
      const org = organizationId || await getOrganizationId() || ""
      if (!org) throw new Error("No licensed business is available.")
      setOrganizationId(org)
      const query = new URLSearchParams({ organization_id: org, financial_year_id: selectedYear.id, report: reportForView[view] || "overview" })
      if (view === "general-ledger" && ledgerAccountId) query.set("account_id", ledgerAccountId)
      if (fromDate) query.set("from", fromDate)
      if (toDate) query.set("to", toDate)
      query.set("transaction_type", transactionType)
      query.set("direction", direction)
      query.set("page", String(reportPage))
      query.set("limit", "50")
      if (reportSearch) query.set("search", reportSearch)
      const [accountResult, statusResult, reportResult] = await Promise.all([
        apiFetch(`/api/accounting/chart?organization_id=${encodeURIComponent(org)}&limit=500`, { cache: "no-store" }).then(payload),
        apiFetch(`/api/accounting/status?organization_id=${encodeURIComponent(org)}`, { cache: "no-store" }).then(payload),
        view === "chart-of-accounts" || (view === "general-ledger" && !ledgerAccountId)
          ? Promise.resolve({} as Row)
          : apiFetch(`/api/accounting/reports?${query.toString()}`, { cache: "no-store" }).then(payload),
      ])
      const nextAccounts = Array.isArray(accountResult.data) ? accountResult.data as Row[] : []
      setAccounts(nextAccounts)
      setStatus(statusResult.status as Row || null)
      setReport(reportResult as Report)
      if (view === "general-ledger" && !ledgerAccountId && nextAccounts[0]?.id) setLedgerAccountId(String(nextAccounts[0].id))
      setNotice("")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Accounting failed to load.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedYear) return
    setFromDate(selectedYear.start_date)
    setToDate(selectedYear.end_date)
    setReportPage(1)
  }, [selectedYear])

  useEffect(() => {
    void load()
    // Reload when the route, selected period, or selected ledger changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedYear?.id, ledgerAccountId, fromDate, toDate, transactionType, direction, reportPage, reportSearch])

  useEffect(() => { setReportPage(1) }, [view, ledgerAccountId])

  async function submit(path: string, body: Row) {
    if (!organizationId) return
    setSaving(true)
    try {
      await payload(await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, organization_id: organizationId, financial_year_id: selectedYear?.id }) }))
      setNotice("Saved and posted to the local accounting journal.")
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The accounting change could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  const reportRows = useMemo(() => {
    if (Array.isArray(report.rows)) return report.rows
    if (view === "profit-loss") return [...(Array.isArray(report.income) ? report.income as Row[] : []), ...(Array.isArray(report.expenses) ? report.expenses as Row[] : [])]
    if (view === "balance-sheet") return [...(Array.isArray(report.assets) ? report.assets as Row[] : []), ...(Array.isArray(report.liabilities) ? report.liabilities as Row[] : []), ...(Array.isArray(report.equity) ? report.equity as Row[] : [])]
    return []
  }, [report, view])

  const active = accountingViews.find((item) => item.id === view) || accountingViews[0]
  const initialized = status && status.initialization_status !== "PENDING"

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.07),transparent_32rem)] text-white print:bg-white print:text-black">
      <div className="mx-auto max-w-[1900px] space-y-5 px-3 py-4 sm:px-5 lg:px-6">
        <header className="rounded-lg border border-white/10 bg-white/[0.035] p-5 print:border-neutral-300 print:bg-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-300">Phase 1 · Local double-entry</p>
              <h1 className="mt-2 text-2xl font-black sm:text-3xl">Accounting · {active.label}</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-400 print:text-neutral-700">Authoritative journals are stored in local SQLite. Posted entries are immutable; corrections use linked reversals.</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-right text-xs print:border-neutral-300 print:bg-white">
              <p className="font-black">{selectedYear?.label || "Financial year"}</p>
              <p className="mt-1 text-neutral-500">{text(selectedYear?.start_date)} → {text(selectedYear?.end_date)}</p>
            </div>
          </div>
        </header>

        <nav aria-label="Accounting views" className="flex gap-2 overflow-x-auto pb-1 print:hidden">
          {accountingViews.map((item) => <Link key={item.id} href={item.id === "overview" ? "/dashboard/accounting" : `/dashboard/accounting/${item.id}`} className={classNames("min-h-10 shrink-0 rounded-xl border px-4 py-2.5 text-xs font-black", item.id === view ? "border-cyan-300/40 bg-cyan-300 text-black" : "border-white/10 bg-white/[0.03] text-neutral-300")}>{item.label}</Link>)}
        </nav>

        {initialized && !["chart-of-accounts", "opening-balances"].includes(view) ? <ReportFilters year={selectedYear} from={fromDate} to={toDate} transactionType={transactionType} direction={direction} showTransactionType={["journal", "general-ledger"].includes(view)} showSearch={["journal", "expenses"].includes(view)} search={searchDraft} onSearchDraft={setSearchDraft} onSearch={() => { setReportSearch(searchDraft.trim()); setReportPage(1) }} onFrom={(value) => { setFromDate(value); setReportPage(1) }} onTo={(value) => { setToDate(value); setReportPage(1) }} onTransactionType={(value) => { setTransactionType(value); setReportPage(1) }} onDirection={(value) => { setDirection(value); setReportPage(1) }} /> : null}

        {notice ? <div role="status" className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100 print:hidden">{notice}</div> : null}

        {!initialized ? (
          <section className="rounded-lg border border-cyan-300/25 bg-cyan-300/[0.07] p-6">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Controlled opening required</p>
            <h2 className="mt-3 text-2xl font-black">Activate the accounting book without rewriting history.</h2>
            <p className="mt-3 max-w-4xl text-sm leading-7 text-neutral-300">Bezgrow will post one balanced opening from current customer receivables, supplier payables, and inventory that has a genuine recorded purchase cost. Existing invoices remain operational history and are not back-posted. Missing legacy costs become visible warnings and are never guessed.</p>
            <button type="button" disabled={saving || !selectedYear?.is_active} onClick={() => submit("/api/accounting/initialize", { opening_date: new Date().toISOString().slice(0, 10) })} className="mt-5 min-h-11 rounded-xl bg-cyan-300 px-5 text-sm font-black text-black disabled:opacity-40">{saving ? "Activating…" : "Create controlled opening"}</button>
          </section>
        ) : null}

        {loading ? <div className="rounded-lg border border-white/10 p-10 text-center text-sm text-neutral-500">Loading local accounting book…</div> : null}

        {!loading && initialized && view === "overview" ? <Overview report={report} status={status} /> : null}
        {!loading && initialized && view === "chart-of-accounts" ? <ChartOfAccounts accounts={accounts} saving={saving} onSubmit={submit} /> : null}
        {!loading && initialized && view === "journal" ? <JournalView report={report} accounts={accounts} expanded={expandedVoucher} setExpanded={setExpandedVoucher} saving={saving} onSubmit={submit} /> : null}
        {!loading && initialized && view === "general-ledger" ? <GeneralLedger report={report} accounts={accounts} selected={ledgerAccountId} onSelect={setLedgerAccountId} /> : null}
        {!loading && initialized && view === "trial-balance" ? <TrialBalance report={report} /> : null}
        {!loading && initialized && view === "profit-loss" ? <ProfitLoss report={report} /> : null}
        {!loading && initialized && view === "balance-sheet" ? <BalanceSheet report={report} /> : null}
        {!loading && initialized && view === "cash-flow" ? <CashFlow report={report} /> : null}
        {!loading && initialized && view === "expenses" ? <Expenses report={report} accounts={accounts} saving={saving} onSubmit={submit} /> : null}
        {!loading && initialized && view === "opening-balances" ? <OpeningBalances report={report} status={status} /> : null}

        {!loading && initialized && ["journal", "general-ledger", "expenses"].includes(view) && number(report.total) > number(report.limit) ? <Pagination page={number(report.page) || reportPage} total={number(report.total)} limit={number(report.limit) || 50} onPage={setReportPage} /> : null}

        {!loading && initialized && !["chart-of-accounts", "journal", "general-ledger", "trial-balance", "profit-loss", "balance-sheet", "cash-flow", "expenses", "opening-balances", "overview"].includes(view) ? <p>Unknown view.</p> : null}
        {!loading && initialized && reportRows.length > 0 ? <div className="hidden">{reportRows.length}</div> : null}
      </div>
    </div>
  )
}

function ReportFilters({ year, from, to, transactionType, direction, showTransactionType, showSearch, search, onSearchDraft, onSearch, onFrom, onTo, onTransactionType, onDirection }: {
  year: { start_date: string; end_date: string } | null | undefined
  from: string
  to: string
  transactionType: string
  direction: "asc" | "desc"
  showTransactionType: boolean
  showSearch: boolean
  search: string
  onSearchDraft: (value: string) => void
  onSearch: () => void
  onFrom: (value: string) => void
  onTo: (value: string) => void
  onTransactionType: (value: string) => void
  onDirection: (value: "asc" | "desc") => void
}) {
  function setCurrentPeriod(kind: "month" | "quarter" | "year") {
    if (!year) return
    if (kind === "year") { onFrom(year.start_date); onTo(year.end_date); return }
    const today = new Date()
    const month = today.getMonth()
    const startMonth = kind === "quarter" ? Math.floor(month / 3) * 3 : month
    const endMonth = kind === "quarter" ? startMonth + 2 : month
    const periodStart = `${today.getFullYear()}-${String(startMonth + 1).padStart(2, "0")}-01`
    const periodEnd = new Date(today.getFullYear(), endMonth + 1, 0).toISOString().slice(0, 10)
    onFrom(periodStart < year.start_date || periodStart > year.end_date ? year.start_date : periodStart)
    onTo(periodEnd < year.start_date || periodEnd > year.end_date ? year.end_date : periodEnd)
  }
  return (
    <section aria-label="Accounting report filters" className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/[0.025] p-3 print:hidden">
      <label className="text-[11px] font-black uppercase tracking-wider text-neutral-500">From<input type="date" min={year?.start_date} max={year?.end_date} value={from} onChange={(event) => onFrom(event.target.value)} className="mt-1 block min-h-10 rounded-lg border border-white/10 bg-black px-3 text-sm text-white" /></label>
      <label className="text-[11px] font-black uppercase tracking-wider text-neutral-500">To<input type="date" min={year?.start_date} max={year?.end_date} value={to} onChange={(event) => onTo(event.target.value)} className="mt-1 block min-h-10 rounded-lg border border-white/10 bg-black px-3 text-sm text-white" /></label>
      {showTransactionType ? <label className="text-[11px] font-black uppercase tracking-wider text-neutral-500">Voucher<select value={transactionType} onChange={(event) => onTransactionType(event.target.value)} className="mt-1 block min-h-10 rounded-lg border border-white/10 bg-black px-3 text-sm text-white"><option value="all">All types</option><option value="sale">Sale</option><option value="receipt">Receipt</option><option value="payment">Payment</option><option value="contra">Contra</option><option value="journal">Journal</option><option value="expense">Expense</option><option value="opening">Opening</option><option value="reversal">Reversal</option></select></label> : null}
      {showTransactionType ? <label className="text-[11px] font-black uppercase tracking-wider text-neutral-500">Order<select value={direction} onChange={(event) => onDirection(event.target.value === "desc" ? "desc" : "asc")} className="mt-1 block min-h-10 rounded-lg border border-white/10 bg-black px-3 text-sm text-white"><option value="asc">Oldest first</option><option value="desc">Newest first</option></select></label> : null}
      {showSearch ? <form onSubmit={(event) => { event.preventDefault(); onSearch() }} className="flex items-end gap-2"><label className="text-[11px] font-black uppercase tracking-wider text-neutral-500">Search<input value={search} onChange={(event) => onSearchDraft(event.target.value)} placeholder="Voucher, reference, payee…" className="mt-1 block min-h-10 rounded-lg border border-white/10 bg-black px-3 text-sm font-normal normal-case tracking-normal text-white" /></label><button className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-black">Apply</button></form> : null}
      <div className="ml-auto flex flex-wrap gap-2"><button type="button" onClick={() => setCurrentPeriod("month")} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-black">Month</button><button type="button" onClick={() => setCurrentPeriod("quarter")} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-black">Quarter</button><button type="button" onClick={() => setCurrentPeriod("year")} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-black">Full year</button></div>
    </section>
  )
}

function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit))
  return <nav aria-label="Report pages" className="flex items-center justify-between rounded-lg border border-white/10 p-3 text-sm print:hidden"><span className="text-neutral-500">Page {page} of {pages} · {total} rows</span><span className="flex gap-2"><button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="min-h-10 rounded-lg border border-white/10 px-4 font-black disabled:opacity-30">Previous</button><button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className="min-h-10 rounded-lg border border-white/10 px-4 font-black disabled:opacity-30">Next</button></span></nav>
}

function Overview({ report, status }: { report: Report; status: Row | null }) {
  const integrity = report.integrity || {}
  return (
    <section className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Net profit" value={moneyMinor(report.netProfitMinor)} tone={number(report.netProfitMinor) >= 0 ? "green" : "amber"} />
        <Metric label="Cash + bank" value={moneyMinor(report.cashMinor)} />
        <Metric label="Receivables" value={moneyMinor(report.receivablesMinor)} />
        <Metric label="Payables" value={moneyMinor(report.payablesMinor)} tone="amber" />
        <Metric label="Revenue" value={moneyMinor(report.incomeMinor)} tone="green" />
        <Metric label="Expenses incl. COGS" value={moneyMinor(report.expenseMinor)} tone="amber" />
        <Metric label="Inventory at cost" value={moneyMinor(report.inventoryMinor)} />
        <Metric label="Cost of goods sold" value={moneyMinor(report.cogsMinor)} tone="amber" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-lg border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Book integrity</h2><p className={classNames("mt-3 text-2xl font-black", integrity.ok ? "text-emerald-300" : "text-rose-300")}>{integrity.ok ? "Exact and balanced" : "Review required"}</p><p className="mt-2 text-sm text-neutral-500">{number(integrity.postedVouchers)} posted vouchers · {number(integrity.openWarnings)} open warnings</p></article>
        <article className="rounded-lg border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Historical strategy</h2><p className="mt-3 text-sm leading-6 text-neutral-400">{text(status?.historical_policy, "CONTROLLED_OPENING")} from {text(status?.opening_date)}. Legacy documents were preserved; the opening voucher is {text(status?.opening_voucher_number, "not required for zero balances")}.</p></article>
      </div>
    </section>
  )
}

function ChartOfAccounts({ accounts, saving, onSubmit }: { accounts: Row[]; saving: boolean; onSubmit: (path: string, body: Row) => Promise<void> }) {
  const [editingId, setEditingId] = useState("")
  const editing = accounts.find((account) => account.id === editingId)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await onSubmit("/api/accounting/chart/save", { ...Object.fromEntries(form.entries()), id: editingId })
    setEditingId("")
    event.currentTarget.reset()
  }
  async function deactivate(id: string) {
    await onSubmit("/api/accounting/chart/deactivate", { account_id: id })
    if (editingId === id) setEditingId("")
  }
  return (
    <section className="space-y-4">
      <form key={editingId || "new"} onSubmit={save} className="grid gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4 md:grid-cols-4 xl:grid-cols-[1fr_2fr_1fr_1fr_1fr_auto_auto]">
        <input name="account_code" required defaultValue={text(editing?.account_code, "")} placeholder="Code" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" />
        <input name="account_name" required defaultValue={text(editing?.account_name, "")} placeholder="Account name" className="rounded-xl border border-white/10 bg-black px-3 py-2.5 md:col-span-2" />
        <select name="account_type" defaultValue={text(editing?.account_type, "EXPENSE")} className="rounded-xl border border-white/10 bg-black px-3 py-2.5"><option>EXPENSE</option><option>ASSET</option><option>LIABILITY</option><option>EQUITY</option><option>INCOME</option></select>
        <select name="normal_balance" defaultValue={text(editing?.normal_balance, "debit")} className="rounded-xl border border-white/10 bg-black px-3 py-2.5"><option value="debit">Debit</option><option value="credit">Credit</option></select>
        <input name="account_group" defaultValue={text(editing?.account_group, "")} placeholder="Group (optional)" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" />
        <button disabled={saving} className="rounded-xl bg-cyan-300 px-4 font-black text-black">{editingId ? "Save rename" : "Add account"}</button>
        {editingId ? <button type="button" onClick={() => setEditingId("")} className="rounded-xl border border-white/10 px-4 py-2 text-xs font-black">Cancel</button> : null}
      </form>
      <div className="flex justify-end"><ReportActions view="chart-of-accounts" rows={accounts} /></div>
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-white/[0.05] text-[11px] uppercase tracking-[0.12em] text-neutral-500"><tr><th className="px-4 py-3">Code</th><th className="px-4 py-3">Account</th><th className="px-4 py-3">Type / Group</th><th className="px-4 py-3 text-right">Current balance</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right print:hidden">Actions</th></tr></thead>
          <tbody className="divide-y divide-white/10">{accounts.map((account) => <tr key={text(account.id)} className="bg-black/20"><td className="px-4 py-3 font-mono">{text(account.account_code)}</td><td className="px-4 py-3"><span className="font-bold">{text(account.account_name)}</span>{number(account.is_system) ? <span className="ml-2 rounded bg-white/10 px-2 py-1 text-[10px] font-black uppercase text-neutral-400">System</span> : null}</td><td className="px-4 py-3 text-neutral-400">{text(account.account_type)} · {text(account.account_group)}</td><td className="px-4 py-3 text-right font-mono font-bold">{moneyMinor(account.current_balance_minor)}</td><td className="px-4 py-3">{number(account.is_active) ? "Active" : "Inactive"}</td><td className="px-4 py-3 text-right print:hidden">{number(account.is_system) ? "—" : <span className="inline-flex gap-2"><button type="button" onClick={() => setEditingId(text(account.id, ""))} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-black">Edit</button><button type="button" disabled={saving || !number(account.is_active)} onClick={() => void deactivate(text(account.id, ""))} className="rounded-lg border border-amber-300/20 px-3 py-2 text-xs font-black text-amber-100 disabled:opacity-35">Deactivate</button></span>}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  )
}

function JournalView({ report, accounts, expanded, setExpanded, saving, onSubmit }: { report: Report; accounts: Row[]; expanded: string; setExpanded: (id: string) => void; saving: boolean; onSubmit: (path: string, body: Row) => Promise<void> }) {
  const rows = report.rows || []
  const entries = report.entries || []
  const [voucherLines, setVoucherLines] = useState(() => [{ key: "line-1", account_id: "", debit: "", credit: "", description: "" }, { key: "line-2", account_id: "", debit: "", credit: "", description: "" }])
  const debitMinor = voucherLines.reduce((sum, line) => sum + Math.round(number(line.debit) * 100), 0)
  const creditMinor = voucherLines.reduce((sum, line) => sum + Math.round(number(line.credit) * 100), 0)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await onSubmit("/api/accounting/vouchers/create", { voucher_date: form.get("voucher_date"), voucher_type: form.get("voucher_type"), reference_no: form.get("reference_no"), narration: form.get("narration"), entries: voucherLines.map((line) => ({ account_id: line.account_id, debit: line.debit, credit: line.credit, description: line.description })) })
    setVoucherLines([{ key: `line-${Date.now()}-1`, account_id: "", debit: "", credit: "", description: "" }, { key: `line-${Date.now()}-2`, account_id: "", debit: "", credit: "", description: "" }])
  }
  function updateLine(key: string, field: "account_id" | "debit" | "credit" | "description", value: string) { setVoucherLines((current) => current.map((line) => line.key === key ? { ...line, [field]: value, ...(field === "debit" && value ? { credit: "" } : {}), ...(field === "credit" && value ? { debit: "" } : {}) } : line)) }
  return <section className="space-y-4"><form onSubmit={save} className="space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-4"><div className="grid gap-3 md:grid-cols-4"><input type="date" name="voucher_date" required defaultValue={new Date().toISOString().slice(0, 10)} className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><select name="voucher_type" className="rounded-xl border border-white/10 bg-black px-3 py-2.5"><option value="journal">Journal</option><option value="receipt">Receipt</option><option value="payment">Payment</option><option value="contra">Contra</option><option value="opening">Opening</option></select><input name="reference_no" placeholder="Reference" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><input name="narration" required placeholder="Narration" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /></div><div className="space-y-2">{voucherLines.map((line, index) => <div key={line.key} className="grid gap-2 rounded-xl border border-white/10 p-2 md:grid-cols-[3rem_2fr_1fr_1fr_2fr_3rem]"><span className="flex items-center justify-center text-xs font-black text-neutral-500">{index + 1}</span><select aria-label={`Account for line ${index + 1}`} required value={line.account_id} onChange={(event) => updateLine(line.key, "account_id", event.target.value)} className="rounded-lg border border-white/10 bg-black px-3 py-2"><option value="">Select account</option>{accounts.map((account) => <option key={text(account.id)} value={text(account.id, "")}>{text(account.account_code)} · {text(account.account_name)}</option>)}</select><input aria-label={`Debit for line ${index + 1}`} inputMode="decimal" min="0" value={line.debit} onChange={(event) => updateLine(line.key, "debit", event.target.value)} placeholder="Debit" className="rounded-lg border border-white/10 bg-black px-3 py-2 text-right font-mono" /><input aria-label={`Credit for line ${index + 1}`} inputMode="decimal" min="0" value={line.credit} onChange={(event) => updateLine(line.key, "credit", event.target.value)} placeholder="Credit" className="rounded-lg border border-white/10 bg-black px-3 py-2 text-right font-mono" /><input aria-label={`Description for line ${index + 1}`} value={line.description} onChange={(event) => updateLine(line.key, "description", event.target.value)} placeholder="Line description" className="rounded-lg border border-white/10 bg-black px-3 py-2" /><button type="button" aria-label={`Remove line ${index + 1}`} disabled={voucherLines.length <= 2} onClick={() => setVoucherLines((current) => current.filter((item) => item.key !== line.key))} className="rounded-lg border border-white/10 text-neutral-400 disabled:opacity-25">×</button></div>)}</div><div className="flex flex-wrap items-center justify-between gap-3"><button type="button" onClick={() => setVoucherLines((current) => [...current, { key: `line-${Date.now()}-${current.length}`, account_id: "", debit: "", credit: "", description: "" }])} className="min-h-10 rounded-xl border border-white/10 px-4 text-xs font-black">Add line</button><div className="flex flex-wrap items-center gap-5 text-sm"><span>Debit <strong className="font-mono">{moneyMinor(debitMinor)}</strong></span><span>Credit <strong className="font-mono">{moneyMinor(creditMinor)}</strong></span><span className={debitMinor === creditMinor && debitMinor > 0 ? "text-emerald-300" : "text-amber-200"}>Difference <strong className="font-mono">{moneyMinor(debitMinor - creditMinor)}</strong></span><button disabled={saving || debitMinor <= 0 || debitMinor !== creditMinor} className="min-h-10 rounded-xl bg-cyan-300 px-5 font-black text-black disabled:opacity-35">Post voucher</button></div></div></form><ReportActions view="journal" rows={rows} /><div className="space-y-2">{rows.map((voucher) => { const id = text(voucher.id, ""); const open = expanded === id; const lines = entries.filter((entry) => entry.voucher_id === voucher.id); return <article key={id} className="overflow-hidden rounded-lg border border-white/10"><button type="button" onClick={() => setExpanded(open ? "" : id)} className="grid w-full gap-2 bg-white/[0.03] p-4 text-left md:grid-cols-5"><span className="font-black">{text(voucher.voucher_number)}</span><span>{text(voucher.voucher_date)}</span><span>{text(voucher.voucher_type)}</span><span className="truncate text-neutral-400">{text(voucher.narration)}</span><span className="text-right font-mono font-black">{moneyMinor(voucher.total_debit_minor)}</span></button>{open ? <div className="p-3"><DataTable rows={lines} columns={[{ key: "line_no", label: "Line" }, { key: "account_code", label: "Code" }, { key: "account_name", label: "Account" }, { key: "debit_minor", label: "Debit", money: true }, { key: "credit_minor", label: "Credit", money: true }, { key: "description", label: "Description" }]} /></div> : null}</article> })}</div></section>
}

function GeneralLedger({ report, accounts, selected, onSelect }: { report: Report; accounts: Row[]; selected: string; onSelect: (id: string) => void }) {
  const rows = report.rows || []
  return <section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><select aria-label="Ledger account" value={selected} onChange={(event) => onSelect(event.target.value)} className="min-h-11 min-w-72 rounded-xl border border-white/10 bg-black px-3">{accounts.map((account) => <option key={text(account.id)} value={text(account.id, "")}>{text(account.account_code)} · {text(account.account_name)}</option>)}</select><ReportActions view="general-ledger" rows={rows} /></div><p className="text-sm text-neutral-500">Opening balance: <strong className="font-mono text-white">{moneyMinor(report.openingMinor)}</strong></p><DataTable rows={rows} columns={[{ key: "voucher_date", label: "Date" }, { key: "voucher_number", label: "Voucher" }, { key: "voucher_type", label: "Type" }, { key: "narration", label: "Particulars" }, { key: "reference_no", label: "Reference" }, { key: "debit_minor", label: "Debit", money: true }, { key: "credit_minor", label: "Credit", money: true }, { key: "running_balance_minor", label: "Running balance", money: true }]} /></section>
}

function TrialBalance({ report }: { report: Report }) { const rows = report.rows || []; const balanced = number(report.totalDebitMinor) === number(report.totalCreditMinor) && Boolean((report.integrity as Row | undefined)?.ok); return <section className="space-y-4">{!balanced ? <div role="alert" className="rounded-lg border border-rose-400/30 bg-rose-400/10 p-4 text-sm font-bold text-rose-100">Accounting integrity warning: Trial Balance totals do not match or a journal diagnostic failed. Do not rely on this report until Accounting Overview shows exact and balanced.</div> : null}<div className="flex justify-end"><ReportActions view="trial-balance" rows={rows} /></div><DataTable rows={rows} columns={[{ key: "account_code", label: "Code" }, { key: "account_name", label: "Account" }, { key: "opening_debit_minor", label: "Opening Dr", money: true }, { key: "opening_credit_minor", label: "Opening Cr", money: true }, { key: "debit_minor", label: "Period Dr", money: true }, { key: "credit_minor", label: "Period Cr", money: true }, { key: "closing_debit_minor", label: "Closing Dr", money: true }, { key: "closing_credit_minor", label: "Closing Cr", money: true }]} /><div className="grid gap-3 sm:grid-cols-2"><Metric label="Closing debit" value={moneyMinor(report.totalDebitMinor)} /><Metric label="Closing credit" value={moneyMinor(report.totalCreditMinor)} /></div></section> }

function ProfitLoss({ report }: { report: Report }) { const rows = [...(Array.isArray(report.income) ? report.income as Row[] : []), ...(Array.isArray(report.expenses) ? report.expenses as Row[] : [])]; return <section className="space-y-4"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Metric label="Income" value={moneyMinor(report.incomeMinor)} tone="green" /><Metric label="COGS" value={moneyMinor(report.cogsMinor)} tone="amber" /><Metric label="Gross profit" value={moneyMinor(report.grossProfitMinor)} tone={number(report.grossProfitMinor) >= 0 ? "green" : "amber"} /><Metric label="Operating expenses" value={moneyMinor(report.operatingExpenseMinor)} tone="amber" /><Metric label="Net profit / loss" value={moneyMinor(report.netProfitMinor)} tone={number(report.netProfitMinor) >= 0 ? "green" : "amber"} /></div><div className="flex justify-end"><ReportActions view="profit-loss" rows={rows} /></div><DataTable rows={rows} columns={[{ key: "account_code", label: "Code" }, { key: "account_name", label: "Account" }, { key: "account_group", label: "Section" }, { key: "debit_minor", label: "Debit", money: true }, { key: "credit_minor", label: "Credit", money: true }, { key: "closing_minor", label: "Balance", money: true }]} /></section> }

function BalanceSheet({ report }: { report: Report }) { const rows = [...(Array.isArray(report.assets) ? report.assets as Row[] : []), ...(Array.isArray(report.liabilities) ? report.liabilities as Row[] : []), ...(Array.isArray(report.equity) ? report.equity as Row[] : [])]; return <section className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><Metric label="Assets" value={moneyMinor(report.assetMinor)} /><Metric label="Liabilities" value={moneyMinor(report.liabilitiesMinor)} tone="amber" /><Metric label="Equity incl. result" value={moneyMinor(report.equityMinor)} tone="green" /></div><div className="flex items-center justify-between"><p className={classNames("text-sm font-black", number(report.differenceMinor) === 0 ? "text-emerald-300" : "text-rose-300")}>Equation difference: {moneyMinor(report.differenceMinor)}</p><ReportActions view="balance-sheet" rows={rows} /></div><DataTable rows={rows} columns={[{ key: "account_code", label: "Code" }, { key: "account_name", label: "Account" }, { key: "account_type", label: "Section" }, { key: "closing_minor", label: "Signed balance", money: true }]} /></section> }

function CashFlow({ report }: { report: Report }) { const rows = report.rows || []; const sections = Array.isArray(report.sections) ? report.sections as Row[] : []; return <section className="space-y-4"><div className="grid gap-3 sm:grid-cols-4"><Metric label="Opening cash" value={moneyMinor(report.openingMinor)} /><Metric label="Inflows" value={moneyMinor(report.inflowMinor)} tone="green" /><Metric label="Outflows" value={moneyMinor(report.outflowMinor)} tone="amber" /><Metric label="Closing cash" value={moneyMinor(report.closingMinor)} /></div><DataTable rows={sections} columns={[{ key: "name", label: "Activity" }, { key: "movementMinor", label: "Net movement", money: true }]} /><p className="text-xs text-neutral-500">{text(report.classificationBasis)}</p><div className="flex justify-end"><ReportActions view="cash-flow" rows={rows} /></div><DataTable rows={rows} columns={[{ key: "account_code", label: "Code" }, { key: "account_name", label: "Cash / bank account" }, { key: "opening_minor", label: "Opening", money: true }, { key: "debit_minor", label: "Inflows", money: true }, { key: "credit_minor", label: "Outflows", money: true }, { key: "closing_minor", label: "Closing", money: true }]} /></section> }

function Expenses({ report, accounts, saving, onSubmit }: { report: Report; accounts: Row[]; saving: boolean; onSubmit: (path: string, body: Row) => Promise<void> }) {
  const expenses = accounts.filter((account) => account.account_type === "EXPENSE")
  const payments = accounts.filter((account) => account.system_role === "CASH" || account.system_role === "BANK" || account.account_type === "LIABILITY")
  const rows = report.rows || []
  async function save(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const body = Object.fromEntries(new FormData(form).entries()); await onSubmit(text(body.expense_id, "") ? "/api/expenses/replace" : "/api/expenses/create", body); form.reset() }
  async function reverse(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; await onSubmit("/api/expenses/reverse", Object.fromEntries(new FormData(form).entries())); form.reset() }
  return <section className="space-y-4"><form onSubmit={save} className="grid gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-4 md:grid-cols-4 xl:grid-cols-8"><input type="date" name="expense_date" required defaultValue={new Date().toISOString().slice(0, 10)} className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><input name="description" required placeholder="Description" className="rounded-xl border border-white/10 bg-black px-3 py-2.5 xl:col-span-2" /><select name="expense_account_id" required className="rounded-xl border border-white/10 bg-black px-3 py-2.5"><option value="">Expense account</option>{expenses.map((account) => <option key={text(account.id)} value={text(account.id, "")}>{text(account.account_name)}</option>)}</select><select name="payment_account_id" required className="rounded-xl border border-white/10 bg-black px-3 py-2.5"><option value="">Paid from / owed to</option>{payments.map((account) => <option key={text(account.id)} value={text(account.id, "")}>{text(account.account_name)}{account.account_type === "LIABILITY" ? " (unpaid)" : ""}</option>)}</select><input name="amount" required inputMode="decimal" placeholder="Total amount" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><input name="cgst" inputMode="decimal" placeholder="CGST" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><button disabled={saving} className="rounded-xl bg-cyan-300 px-4 font-black text-black">Post expense</button><input name="sgst" inputMode="decimal" placeholder="SGST" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><input name="igst" inputMode="decimal" placeholder="IGST" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><input name="vendor_name" placeholder="Vendor" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><input name="reference_no" placeholder="Reference" className="rounded-xl border border-white/10 bg-black px-3 py-2.5" /><input name="expense_id" placeholder="Existing expense ID (replace only)" className="rounded-xl border border-white/10 bg-black px-3 py-2.5 xl:col-span-2" /><input name="reason" placeholder="Replacement reason" className="rounded-xl border border-white/10 bg-black px-3 py-2.5 xl:col-span-2" /></form><form onSubmit={reverse} className="flex flex-wrap gap-3 rounded-lg border border-amber-300/15 bg-amber-300/5 p-4"><input name="expense_id" required placeholder="Expense ID to reverse" className="min-h-10 flex-1 rounded-xl border border-white/10 bg-black px-3" /><input name="reason" required placeholder="Required reversal reason" className="min-h-10 flex-[2] rounded-xl border border-white/10 bg-black px-3" /><input type="date" name="reversal_date" required defaultValue={new Date().toISOString().slice(0, 10)} className="min-h-10 rounded-xl border border-white/10 bg-black px-3" /><button disabled={saving} className="rounded-xl border border-amber-300/30 px-4 text-sm font-black text-amber-100">Reverse expense</button></form><div className="flex justify-end"><ReportActions view="expenses" rows={rows} /></div><DataTable rows={rows} columns={[{ key: "id", label: "Expense ID" }, { key: "expense_date", label: "Date" }, { key: "description", label: "Description" }, { key: "vendor_name", label: "Vendor" }, { key: "payment_status", label: "Status" }, { key: "revision", label: "Revision" }, { key: "amount_minor", label: "Amount", money: true }, { key: "outstanding_amount", label: "Outstanding" }, { key: "reversed_at", label: "Reversed" }, { key: "reference_no", label: "Reference" }]} /></section>
}

function OpeningBalances({ report, status }: { report: Report; status: Row | null }) { const rows = report.rows || []; return <section className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><Metric label="Opening date" value={text(status?.opening_date)} /><Metric label="Opening voucher" value={text(status?.opening_voucher_number, "Zero balance — none")} /><Metric label="Open valuation warnings" value={String(number(status?.open_warnings))} tone={number(status?.open_warnings) ? "amber" : "green"} /></div><article className="rounded-lg border border-white/10 bg-white/[0.03] p-5 text-sm leading-6 text-neutral-400"><strong className="text-white">Controlled opening:</strong> current receivables and payables are brought forward by party; stock is valued only from recorded batch or product purchase cost. A missing rate is disclosed below and never replaced with a guess.<div className="mt-4"><Link href="/dashboard/accounting/journal" className="inline-flex min-h-10 items-center rounded-xl border border-cyan-300/30 px-4 font-black text-cyan-100">Post a balanced Opening voucher</Link></div><p className="mt-3 text-xs text-amber-100">Inventory openings must come from the controlled physical-stock valuation; manual inventory ledger openings are blocked to prevent stock/value divergence.</p></article><DataTable rows={rows} columns={[{ key: "created_at", label: "Detected" }, { key: "warning_code", label: "Code" }, { key: "message", label: "Warning" }, { key: "status", label: "Status" }]} empty="No accounting valuation warnings." /></section> }
