"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { resolveBusinessLogoUrl } from "@/lib/business-logo"
import { openPdfForNativePrinting, saveDesktopBytes, type DesktopSavedFile } from "@/lib/desktop-file-export"
import {
  defaultInvoiceExportOptions,
  exportInvoicesCsv,
  loadInvoiceExportDataset,
  type InvoiceDatePreset,
  type InvoiceExportDataset,
  type InvoiceExportFilters,
  type InvoiceExportOptions,
} from "@/lib/invoice-csv-export"
import {
  createInvoiceReportPdf,
  datasetForInvoiceReport,
  type InvoiceReportOptions,
  type InvoiceReportResult,
  type InvoiceReportType,
} from "@/lib/invoice-report-pdf"
import { invokeTauri, isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import { normalizeWhatsAppPhone, validateCustomerEmail } from "@/lib/invoice-share"

type Customer = {
  id: string
  name: string | null
  phone?: string | null
  email?: string | null
}

type ExportKind = "csv" | "pdf"

type ReportShareState = {
  channel: "whatsapp" | "email"
  phone: string
  email: string
  busy: boolean
  error: string
}

type Props = {
  kind: ExportKind
  organizationId: string
  customers: Customer[]
  initialSearch?: string
  initialStatus?: string
  initialPeriod?: string
  initialCustomerId?: string
  onClose: () => void
  onNotice: (message: string) => void
}

const datePresets: Array<[InvoiceDatePreset, string]> = [
  ["all", "All time"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["this-week", "This week"],
  ["last-7-days", "Last 7 days"],
  ["this-month", "This month"],
  ["previous-month", "Previous month"],
  ["financial-year", "This financial year"],
  ["custom", "Custom date range"],
]

const statuses = [
  ["paid", "Paid"],
  ["partial", "Partially paid"],
  ["unpaid", "Unpaid"],
  ["overdue", "Overdue"],
  ["cancelled", "Cancelled"],
] as const

const paymentMethods = ["Cash", "Card", "UPI", "Bank transfer", "Credit", "Other"]

const reportTypes: Array<[InvoiceReportType, string]> = [
  ["invoice-register", "Invoice Register"],
  ["sales-summary", "Sales Summary"],
  ["customer-wise-sales", "Customer-wise Sales"],
  ["outstanding-receivables", "Outstanding Receivables"],
  ["gst-summary", "GST Summary"],
  ["payment-collection", "Payment Collection Report"],
  ["detailed-lines", "Detailed Invoice Lines"],
]

function initialDatePreset(value?: string): InvoiceDatePreset {
  if (value === "week") return "last-7-days"
  if (value === "month") return "this-month"
  return datePresets.some(([key]) => key === value) ? value as InvoiceDatePreset : "all"
}

function defaultFilters(props: Props): InvoiceExportFilters {
  return {
    datePreset: initialDatePreset(props.initialPeriod),
    fromDate: "",
    toDate: "",
    statuses: props.initialStatus && props.initialStatus !== "all" ? [props.initialStatus] : [],
    customerIds: props.initialCustomerId && props.initialCustomerId !== "all" ? [props.initialCustomerId] : [],
    customerSearch: "",
    paymentMethods: [],
    invoiceType: "all",
    minimumAmount: null,
    maximumAmount: null,
    invoiceNumberFrom: "",
    invoiceNumberTo: "",
    search: props.initialSearch || "",
    includeCancelled: false,
    includeArchived: false,
  }
}

const defaultReportOptions: InvoiceReportOptions = {
  reportType: "invoice-register",
  orientation: "auto",
  pageSize: "A4",
  includeGstDetails: true,
  includeLineItems: false,
  includeCustomerContacts: false,
  includePaymentSummary: true,
  includeCharts: false,
}

function money(value: number) {
  return `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fieldNumber(value: string) {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function localDateValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function InvoiceExportModal(props: Props) {
  const [filters, setFilters] = useState<InvoiceExportFilters>(() => defaultFilters(props))
  const [options, setOptions] = useState<InvoiceExportOptions>(defaultInvoiceExportOptions)
  const [reportOptions, setReportOptions] = useState<InvoiceReportOptions>(defaultReportOptions)
  const [dataset, setDataset] = useState<InvoiceExportDataset | null>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [progress, setProgress] = useState("")
  const [result, setResult] = useState<InvoiceReportResult | null>(null)
  const [previewUrl, setPreviewUrl] = useState("")
  const [savedFile, setSavedFile] = useState<DesktopSavedFile | null>(null)
  const [reportShare, setReportShare] = useState<ReportShareState | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    return () => {
      cancelled.current = true
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const customerOptions = useMemo(() => {
    const term = filters.customerSearch?.trim().toLowerCase() || ""
    if (!term) return props.customers
    return props.customers.filter((customer) =>
      [customer.name, customer.phone, customer.email].join(" ").toLowerCase().includes(term)
    )
  }, [filters.customerSearch, props.customers])

  function patchFilters(patch: Partial<InvoiceExportFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setDataset(null)
    setError("")
  }

  function toggleArray(field: "statuses" | "paymentMethods" | "customerIds", value: string) {
    const current = filters[field] || []
    patchFilters({ [field]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] })
  }

  function changeDatePreset(datePreset: InvoiceDatePreset) {
    if (datePreset !== "custom") {
      patchFilters({ datePreset })
      return
    }
    const today = new Date()
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    patchFilters({
      datePreset,
      fromDate: filters.fromDate || localDateValue(monthStart),
      toDate: filters.toDate || localDateValue(today),
    })
  }

  function validate() {
    if (filters.datePreset === "custom") {
      if (!filters.fromDate || !filters.toDate) return "Choose both From and To dates."
      if (filters.fromDate > filters.toDate) return "The from date must not be after the to date."
    }
    if (filters.minimumAmount !== null && filters.maximumAmount !== null &&
      filters.minimumAmount !== undefined && filters.maximumAmount !== undefined &&
      filters.minimumAmount > filters.maximumAmount) {
      return "Minimum amount must not be greater than maximum amount."
    }
    return ""
  }

  async function prepareData(forceDetailed = false) {
    const validation = validate()
    if (validation) {
      setError(validation)
      return null
    }
    const effectiveOptions = forceDetailed ? { ...options, mode: "detailed" as const } : options
    setBusy("preview")
    setProgress("Filtering local SQLite invoice data...")
    setError("")
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
    try {
      const loaded = await loadInvoiceExportDataset(props.organizationId, filters, effectiveOptions)
      const next = props.kind === "pdf" ? datasetForInvoiceReport(loaded, reportOptions.reportType) : loaded
      if (cancelled.current) return null
      setDataset(next)
      if (!next.summary.invoiceCount) {
        setError("No invoices match these filters.")
        return null
      }
      setProgress(`Preview ready: ${next.summary.invoiceCount.toLocaleString("en-IN")} matching invoices.`)
      return next
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Invoice data could not be prepared.")
      return null
    } finally {
      setBusy("")
    }
  }

  async function exportCsvFile() {
    const prepared = dataset || await prepareData(options.mode === "detailed")
    if (!prepared?.summary.invoiceCount) return
    setBusy("csv")
    setProgress("Building UTF-8 CSV...")
    try {
      const { result: saved, rowCount } = await exportInvoicesCsv(props.organizationId, filters, options, prepared)
      if (!saved) {
        setProgress("")
        return
      }
      props.onNotice(`CSV exported with ${rowCount.toLocaleString("en-IN")} invoices: ${saved.path || saved.filename}.`)
      props.onClose()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Invoice CSV export failed.")
    } finally {
      setBusy("")
    }
  }

  async function generatePdfReport() {
    const forceDetailed = reportOptions.includeLineItems || reportOptions.reportType === "detailed-lines"
    const prepared = dataset || await prepareData(forceDetailed)
    if (!prepared?.summary.invoiceCount) return
    setBusy("pdf")
    setProgress("Generating report pages...")
    setError("")
    try {
      const logoPath = typeof prepared.organization?.logo_path === "string" ? prepared.organization.logo_path : ""
      const logoUrl = logoPath ? await resolveBusinessLogoUrl(logoPath).catch(() => "") : ""
      const nextResult = await createInvoiceReportPdf(prepared, { ...reportOptions, logoUrl })
      if (cancelled.current) return
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      const blob = new Blob([nextResult.bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" })
      setPreviewUrl(URL.createObjectURL(blob))
      setResult(nextResult)
      setSavedFile(null)
      setProgress(`Report generated: ${nextResult.invoiceCount.toLocaleString("en-IN")} invoices, ${(nextResult.bytes.length / 1024).toFixed(1)} KB.`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Invoice report PDF generation failed.")
    } finally {
      setBusy("")
    }
  }

  async function saveReport() {
    if (!result) return
    setBusy("save")
    setError("")
    try {
      const saved = await saveDesktopBytes(result.filename, result.bytes, "pdf")
      if (!saved) return
      setSavedFile(saved)
      props.onNotice(`Report saved to ${saved.path || saved.filename}.`)
    } catch (nextError) {
      setError(nextError instanceof Error ? `The file could not be saved because ${nextError.message}` : "The report could not be saved.")
    } finally {
      setBusy("")
    }
  }

  async function printReport() {
    if (!result) return
    setBusy("print")
    setError("")
    try {
      const opened = await openPdfForNativePrinting(result.filename, result.bytes, result.pageCount)
      if (opened.bytes !== result.bytes.byteLength || opened.pageCount !== result.pageCount) {
        throw new Error("The operating system received a different report PDF than the preview.")
      }
      props.onNotice(opened.status === "cancelled"
        ? "Report printing was cancelled. The exact report PDF remains ready to print again."
        : opened.status === "printed"
          ? "The operating system accepted the exact report PDF for printing."
          : "The system print dialog opened with the exact report PDF.")
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The operating system rejected printing.")
    } finally {
      setBusy("")
    }
  }

  async function shareReport() {
    if (!result) return
    const file = new File([result.bytes.slice().buffer as ArrayBuffer], result.filename, { type: "application/pdf" })
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try {
        await navigator.share({ title: result.title, text: `${result.title} - ${result.period}`, files: [file] })
        props.onNotice("The system share sheet completed.")
        return
      } catch (shareError) {
        if (shareError instanceof DOMException && shareError.name === "AbortError") return
        setError(shareError instanceof Error ? shareError.message : "The system share sheet failed.")
        return
      }
    }
    setError("The operating-system share sheet is unavailable. Save the PDF, then use Email or WhatsApp.")
  }

  async function openSavedFile(reveal = false) {
    if (!savedFile?.path) {
      setError("Save the PDF before opening it or showing it in a folder.")
      return
    }
    try {
      if (!(await isTauriRuntimeAsync())) {
        window.open(previewUrl, "_blank", "noopener,noreferrer")
        return
      }
      await invokeTauri<void>(reveal ? "desktop_reveal_file" : "desktop_open_file", { path: savedFile.path })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "The saved report could not be opened.")
    }
  }

  function reportShareMessage(link?: string) {
    if (!result || !dataset) return ""
    return [
      `Hello,`,
      "",
      `Please find ${result.title} from ${dataset.businessName}.`,
      `Period: ${result.period}`,
      `Invoices: ${result.invoiceCount.toLocaleString("en-IN")}`,
      "",
      link ? `View or download the report:\n${link}` : "This report was generated securely by Bezgrow.",
      "",
      "Thank you,",
      dataset.businessName,
      "Generated by Bezgrow",
    ].join("\n")
  }

  function openReportShare(channel: ReportShareState["channel"]) {
    setReportShare({
      channel,
      phone: "",
      email: "",
      busy: false,
      error: "",
    })
  }

  async function copyReportShareMessage() {
    if (!reportShare || !result) return
    const message = reportShareMessage()
    const text = reportShare.channel === "email"
      ? `Subject: ${result.title} from ${dataset?.businessName || "Business"}\n\n${message}`
      : message
    await navigator.clipboard.writeText(text)
    props.onNotice(reportShare.channel === "email" ? "Prepared report email copied." : "Prepared report WhatsApp message copied.")
  }

  async function openPreparedReportMessage() {
    if (!reportShare || !result || !dataset || reportShare.busy) return
    const phone = normalizeWhatsAppPhone(reportShare.phone)
    const email = validateCustomerEmail(reportShare.email)
    if (reportShare.channel === "whatsapp" && !phone) {
      setReportShare({ ...reportShare, error: "Enter a valid mobile number with country code." })
      return
    }
    if (reportShare.channel === "email" && !email) {
      setReportShare({ ...reportShare, error: "Enter a valid email address." })
      return
    }
    setReportShare({ ...reportShare, phone: phone || reportShare.phone, email: email || reportShare.email, busy: true, error: "" })
    try {
      const message = reportShareMessage()
      if (reportShare.channel === "whatsapp") {
        await openExternalUrl(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`)
        props.onNotice("WhatsApp opened with the prepared message. Attach the saved local PDF.")
      } else {
        const subject = `${result.title} from ${dataset.businessName}`
        await openExternalUrl(`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`)
        props.onNotice("The email draft opened. Attach the saved local PDF.")
      }
      setReportShare({ ...reportShare, phone: phone || reportShare.phone, email: email || reportShare.email, busy: false, error: "" })
    } catch (shareError) {
      setReportShare((current) => current ? {
        ...current,
        busy: false,
        error: shareError instanceof Error ? shareError.message : "The prepared report message could not be opened.",
      } : null)
    }
  }

  function reset() {
    setFilters(defaultFilters({ ...props, initialSearch: "", initialStatus: "all", initialPeriod: "all", initialCustomerId: "all" }))
    setOptions(defaultInvoiceExportOptions)
    setReportOptions(defaultReportOptions)
    setDataset(null)
    setError("")
    setProgress("")
  }

  if (result && dataset) {
    return (
      <>
      <div className="fixed inset-0 z-[90] overflow-y-auto bg-black/80 p-3 backdrop-blur-xl sm:p-6" role="presentation">
        <section className="mx-auto grid min-h-full max-w-6xl content-start gap-5 rounded-[28px] border border-white/10 bg-[#080c12] p-4 text-white shadow-2xl sm:p-6" role="dialog" aria-modal="true" aria-labelledby="report-result-title">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">PDF Report Ready</p>
              <h2 id="report-result-title" className="mt-2 text-3xl font-black">{result.title}</h2>
              <p className="mt-2 text-sm text-neutral-400">{result.period} | {result.invoiceCount.toLocaleString("en-IN")} invoices</p>
              <p className="mt-1 text-xs text-neutral-500">{result.filename} | {(result.bytes.length / 1024).toFixed(1)} KB</p>
            </div>
            <button onClick={props.onClose} className="h-11 rounded-xl border border-white/10 px-4 text-sm font-black">Close</button>
          </header>

          {error && <div className="rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>}
          {progress && <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">{progress}</div>}

          <div className="grid gap-4 lg:grid-cols-[1fr,260px]">
            <iframe title={`${result.title} preview`} src={previewUrl} className="h-[68dvh] min-h-[560px] w-full rounded-2xl bg-white" />
            <aside className="grid content-start gap-2 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
              <button onClick={() => void printReport()} disabled={Boolean(busy)} className="report-action primary">{busy === "print" ? "Opening..." : "Print"}</button>
              <button onClick={() => void saveReport()} disabled={Boolean(busy)} className="report-action">{busy === "save" ? "Saving..." : "Save PDF"}</button>
              <button onClick={() => void shareReport()} disabled={Boolean(busy)} className="report-action">Share</button>
              <button onClick={() => openReportShare("email")} className="report-action">Email</button>
              <button onClick={() => openReportShare("whatsapp")} className="report-action">WhatsApp</button>
              <button onClick={() => void openSavedFile(false)} className="report-action">Open File</button>
              <button onClick={() => void openSavedFile(true)} className="report-action">Show in Folder</button>
              <button onClick={props.onClose} className="report-action">Close</button>
            </aside>
          </div>
          {reportShare && (
            <div className="fixed inset-0 z-[110] grid place-items-center overflow-y-auto bg-black/80 p-4 backdrop-blur-xl" role="presentation">
              <section data-enter-navigation="true" className="grid w-full max-w-lg gap-4 rounded-3xl border border-white/10 bg-[#080d16] p-5 shadow-2xl" role="dialog" aria-modal="true" aria-label="Local report sharing">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">{reportShare.channel === "whatsapp" ? "WhatsApp Report" : "Email Report"}</p>
                  <h3 className="mt-2 text-2xl font-black">Prepare local PDF share</h3>
                  <p className="mt-2 text-sm text-neutral-400">The report remains on this device. Bezgrow does not upload it.</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3"><span className="text-neutral-500">Report</span><strong className="mt-1 block">{result.title}</strong></div>
                  <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3"><span className="text-neutral-500">File</span><strong className="mt-1 block break-words">{result.filename}</strong></div>
                </div>
                {reportShare.channel === "whatsapp" ? (
                  <label><span>Recipient phone</span><input className="export-field" inputMode="tel" value={reportShare.phone} onChange={(event) => setReportShare({ ...reportShare, phone: event.target.value, error: "" })} placeholder="9876543210 or country code + number" /></label>
                ) : (
                  <label><span>Recipient email</span><input className="export-field" inputMode="email" value={reportShare.email} onChange={(event) => setReportShare({ ...reportShare, email: event.target.value, error: "" })} placeholder="recipient@example.com" /></label>
                )}
                {reportShare.error && <div className="rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100">{reportShare.error}</div>}
                <div className="grid gap-2 sm:grid-cols-2">
                  <button className="report-action" onClick={() => void saveReport()}>Save PDF</button>
                  <button className="report-action" onClick={() => void copyReportShareMessage()}>{reportShare.channel === "email" ? "Copy Email Message" : "Copy prepared message"}</button>
                  <button data-enter-primary="true" className="report-action primary" onClick={() => void openPreparedReportMessage()} disabled={reportShare.busy}>{reportShare.busy ? "Opening..." : reportShare.channel === "email" ? "Open Email Draft" : "Open WhatsApp"}</button>
                  <button className="report-action" onClick={() => setReportShare(null)} disabled={reportShare.busy}>Close</button>
                </div>
              </section>
            </div>
          )}

        </section>
        <ModalStyles />
      </div>
      </>
    )
  }

  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-black/80 p-3 backdrop-blur-xl sm:p-6" role="presentation">
      <section data-enter-navigation="true" className="mx-auto max-w-6xl rounded-[28px] border border-white/10 bg-[#080c12] p-4 text-white shadow-2xl sm:p-6" role="dialog" aria-modal="true" aria-labelledby="invoice-export-title">
        <header className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">{props.kind === "csv" ? "Structured Offline Export" : "Professional PDF Report"}</p>
            <h2 id="invoice-export-title" className="mt-2 text-3xl font-black">{props.kind === "csv" ? "Export Invoices" : "Invoice Report PDF"}</h2>
            <p className="mt-2 text-sm text-neutral-400">Filters are applied to organization-scoped local SQLite data.</p>
          </div>
          <button onClick={props.onClose} disabled={Boolean(busy)} className="h-11 rounded-xl border border-white/10 px-4 text-sm font-black">Cancel</button>
        </header>

        <div className="mt-5 grid gap-5 xl:grid-cols-[1fr,330px]">
          <div className="grid gap-5">
            <FilterSection title="Date range">
              <select value={filters.datePreset} onChange={(event) => changeDatePreset(event.target.value as InvoiceDatePreset)} className="export-field">
                {datePresets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              {filters.datePreset === "custom" && (
                <>
                  <label><span>From date</span><input type="date" value={filters.fromDate || ""} onChange={(event) => patchFilters({ fromDate: event.target.value })} className="export-field" /></label>
                  <label><span>To date</span><input type="date" value={filters.toDate || ""} onChange={(event) => patchFilters({ toDate: event.target.value })} className="export-field" /></label>
                </>
              )}
            </FilterSection>

            <FilterSection title="Invoice filters">
              <div className="export-check-grid">
                {statuses.map(([value, label]) => (
                  <label key={value} className="export-check"><input type="checkbox" checked={(filters.statuses || []).includes(value)} onChange={() => toggleArray("statuses", value)} /><span>{label}</span></label>
                ))}
              </div>
              <input value={filters.search || ""} onChange={(event) => patchFilters({ search: event.target.value })} placeholder="Search invoice number" className="export-field" />
              <select value={filters.invoiceType || "all"} onChange={(event) => patchFilters({ invoiceType: event.target.value as InvoiceExportFilters["invoiceType"] })} className="export-field">
                <option value="all">All invoices</option><option value="gst">GST invoices</option><option value="non-gst">Non-GST invoices</option>
              </select>
              <label><span>Invoice number from</span><input value={filters.invoiceNumberFrom || ""} onChange={(event) => patchFilters({ invoiceNumberFrom: event.target.value })} className="export-field" /></label>
              <label><span>Invoice number to</span><input value={filters.invoiceNumberTo || ""} onChange={(event) => patchFilters({ invoiceNumberTo: event.target.value })} className="export-field" /></label>
            </FilterSection>

            <FilterSection title="Customers">
              <input value={filters.customerSearch || ""} onChange={(event) => patchFilters({ customerSearch: event.target.value })} placeholder="Search name, phone, email, or GSTIN" className="export-field" />
              <select
                value={(filters.customerIds || [])[0] || "all"}
                onChange={(event) => patchFilters({ customerIds: event.target.value === "all" ? [] : [event.target.value] })}
                className="export-field"
              >
                <option value="all">All customers</option>
                {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name || "Unnamed customer"}</option>)}
              </select>
            </FilterSection>

            <FilterSection title="Payments and amount">
              <div className="export-check-grid">
                {paymentMethods.map((method) => (
                  <label key={method} className="export-check"><input type="checkbox" checked={(filters.paymentMethods || []).includes(method)} onChange={() => toggleArray("paymentMethods", method)} /><span>{method}</span></label>
                ))}
              </div>
              <label><span>Minimum amount</span><input inputMode="decimal" value={filters.minimumAmount ?? ""} onChange={(event) => patchFilters({ minimumAmount: fieldNumber(event.target.value) })} className="export-field" /></label>
              <label><span>Maximum amount</span><input inputMode="decimal" value={filters.maximumAmount ?? ""} onChange={(event) => patchFilters({ maximumAmount: fieldNumber(event.target.value) })} className="export-field" /></label>
            </FilterSection>

            {props.kind === "csv" ? (
              <FilterSection title="Export options">
                <select value={options.mode} onChange={(event) => { setOptions({ ...options, mode: event.target.value as InvoiceExportOptions["mode"] }); setDataset(null) }} className="export-field">
                  <option value="summary">Invoice summary</option><option value="detailed">Detailed invoice lines</option>
                </select>
                <OptionChecks options={options} onChange={(next) => { setOptions(next); setDataset(null) }} />
              </FilterSection>
            ) : (
              <FilterSection title="Report options">
                <select value={reportOptions.reportType} onChange={(event) => { setReportOptions({ ...reportOptions, reportType: event.target.value as InvoiceReportType }); setDataset(null) }} className="export-field">
                  {reportTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select value={reportOptions.orientation} onChange={(event) => setReportOptions({ ...reportOptions, orientation: event.target.value as InvoiceReportOptions["orientation"] })} className="export-field">
                  <option value="auto">Auto orientation</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option>
                </select>
                <select value={reportOptions.pageSize} onChange={(event) => setReportOptions({ ...reportOptions, pageSize: event.target.value as InvoiceReportOptions["pageSize"] })} className="export-field">
                  <option value="A4">A4</option><option value="Letter">Letter</option>
                </select>
                {[
                  ["includeGstDetails", "Include GST details"],
                  ["includeLineItems", "Include invoice line items"],
                  ["includeCustomerContacts", "Include customer contact details"],
                  ["includePaymentSummary", "Include payment summary"],
                ].map(([key, label]) => (
                  <label key={key} className="export-check"><input type="checkbox" checked={Boolean(reportOptions[key as keyof InvoiceReportOptions])} onChange={(event) => { setReportOptions({ ...reportOptions, [key]: event.target.checked }); setDataset(null) }} /><span>{label}</span></label>
                ))}
              </FilterSection>
            )}
          </div>

          <aside className="xl:sticky xl:top-0 xl:self-start">
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
              <h3 className="text-lg font-black">Result preview</h3>
              {dataset ? (
                <dl className="mt-4 grid grid-cols-2 gap-3">
                  <Metric label="Invoices" value={dataset.summary.invoiceCount.toLocaleString("en-IN")} />
                  <Metric label="Revenue" value={money(dataset.summary.grandTotal)} />
                  <Metric label="Taxable" value={money(dataset.summary.taxableAmount)} />
                  <Metric label="GST" value={money(dataset.summary.totalGst)} />
                  <Metric label="Paid" value={money(dataset.summary.paidAmount)} />
                  <Metric label="Outstanding" value={money(dataset.summary.outstandingAmount)} />
                </dl>
              ) : <p className="mt-4 text-sm leading-6 text-neutral-500">Choose filters, then preview the matching SQLite data before saving.</p>}
              {progress && <p className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">{progress}</p>}
              {error && <p className="mt-4 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-100">{error}</p>}
              <div className="mt-4 grid gap-2">
                <button onClick={() => void prepareData(props.kind === "pdf" && (reportOptions.includeLineItems || reportOptions.reportType === "detailed-lines"))} disabled={Boolean(busy)} className="h-12 rounded-xl border border-white/10 bg-white/[0.06] font-black">
                  {busy === "preview" ? "Preparing..." : props.kind === "csv" ? "Preview Data" : "Preview Report"}
                </button>
                <button data-enter-primary="true" onClick={props.kind === "csv" ? () => void exportCsvFile() : () => void generatePdfReport()} disabled={Boolean(busy) || dataset?.summary.invoiceCount === 0} className="h-12 rounded-xl bg-white font-black text-black disabled:opacity-50">
                  {props.kind === "csv" ? (busy === "csv" ? "Exporting..." : "Export CSV") : (busy === "pdf" ? "Generating..." : "Generate PDF")}
                </button>
                <button onClick={reset} disabled={Boolean(busy)} className="h-11 rounded-xl border border-white/10 text-sm font-black">Reset Filters</button>
                <button onClick={props.onClose} disabled={Boolean(busy)} className="h-11 rounded-xl border border-white/10 text-sm font-black">Cancel</button>
              </div>
            </div>
          </aside>
        </div>
      </section>
      <ModalStyles />
    </div>
  )
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-white/10 bg-white/[0.025] p-4">
      <h3 className="text-sm font-black uppercase tracking-[0.16em] text-cyan-100">{title}</h3>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  )
}

function OptionChecks({ options, onChange }: { options: InvoiceExportOptions; onChange: (options: InvoiceExportOptions) => void }) {
  const entries: Array<[keyof InvoiceExportOptions, string]> = [
    ["includeCustomerContacts", "Include customer contact details"],
    ["includeGstBreakdown", "Include GST breakdown"],
    ["includePaymentDetails", "Include payment details"],
    ["includeNotes", "Include notes"],
    ["includeTimestamps", "Include timestamps"],
  ]
  return entries.map(([key, label]) => (
    <label key={key} className="export-check">
      <input type="checkbox" checked={Boolean(options[key])} onChange={(event) => onChange({ ...options, [key]: event.target.checked })} />
      <span>{label}</span>
    </label>
  ))
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl border border-white/10 bg-black/25 p-3"><dt className="text-[10px] font-black uppercase tracking-[0.12em] text-neutral-500">{label}</dt><dd className="mt-2 break-words text-sm font-black">{value}</dd></div>
}

function ModalStyles() {
  return (
    <style jsx global>{`
      .export-field { min-height: 46px; width: 100%; min-width: 0; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(255,255,255,.055); color: #fff; padding: 0 12px; outline: none; }
      label:has(> .export-field) { display: grid; gap: 6px; color: #94a3b8; font-size: 11px; font-weight: 800; }
      .export-check-grid { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
      .export-check { min-height: 42px; display: flex; align-items: center; gap: 9px; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; background: rgba(255,255,255,.03); padding: 8px 10px; color: #cbd5e1; font-size: 12px; font-weight: 750; }
      .export-check input { accent-color: #22d3ee; }
      .report-action { min-height: 45px; border: 1px solid rgba(255,255,255,.1); border-radius: 12px; background: rgba(255,255,255,.05); color: #fff; font-size: 13px; font-weight: 900; }
      .report-action.primary { background: #fff; color: #020617; }
      .report-action:disabled { cursor: wait; opacity: .55; }
      @media (max-width: 640px) {
        .export-check-grid { grid-template-columns: 1fr; }
      }
    `}</style>
  )
}
