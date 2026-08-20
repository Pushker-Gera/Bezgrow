"use client"

import { useState } from "react"
import { exportCsv, type CsvColumn } from "@/lib/desktop-file-export"
import { getOfflineData, type OfflineCollection } from "@/lib/offline/db"
import { getOfflineReport } from "@/lib/offline/local/erp"

type DataRow = Record<string, unknown>

const exports: Array<{ label: string; slug: string; collection?: OfflineCollection; report?: string }> = [
  { label: "Products", slug: "products", collection: "products" },
  { label: "Customers", slug: "customers", collection: "customers" },
  { label: "Inventory", slug: "inventory", collection: "inventory_items" },
  { label: "Suppliers", slug: "suppliers", collection: "suppliers" },
  { label: "Purchases", slug: "purchases", collection: "purchase_invoices" },
  { label: "Payments", slug: "payments", collection: "payments" },
  { label: "Expenses", slug: "expenses", collection: "expenses" },
  { label: "Reports", slug: "profit-loss-report", report: "profit_loss" },
]

function displayHeader(key: string) {
  return key
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function csvValue(value: unknown) {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return value
}

function columnsFor(rows: DataRow[]): CsvColumn<DataRow>[] {
  const keys = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => {
        if (!["deleted_at", "sync_status", "offline_local_id", "server_id", "last_synced_at"].includes(key)) set.add(key)
      })
      return set
    }, new Set<string>())
  )
  return keys.map((key) => ({
    header: displayHeader(key),
    value: (row) => csvValue(row[key]),
    preserveLeadingZeros: /(^|_)(number|phone|gstin|gst_number|tax_id|sku|barcode|code|reference|tracking)($|_)/i.test(key),
  }))
}

export function LocalDataExportsPanel({ organizationId }: { organizationId: string }) {
  const [active, setActive] = useState("")
  const [notice, setNotice] = useState("")

  async function runExport(item: (typeof exports)[number]) {
    if (!organizationId || active) return
    setActive(item.slug)
    setNotice("")
    try {
      let rows: DataRow[]
      if (item.report) {
        const report = await getOfflineReport(organizationId, item.report)
        rows = [report as DataRow]
      } else {
        rows = await getOfflineData<DataRow[]>(organizationId, item.collection as OfflineCollection, [])
        rows = rows.filter((row) => !row.deleted_at)
      }
      if (rows.length === 0) {
        setNotice(`No ${item.label.toLowerCase()} records are available to export.`)
        return
      }
      const result = await exportCsv(
        `bezgrow-${item.slug}-${new Date().toISOString().slice(0, 10)}.csv`,
        columnsFor(rows),
        rows
      )
      if (result) setNotice(`${item.label} exported to ${result.path || result.filename}.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${item.label} export failed.`)
    } finally {
      setActive("")
    }
  }

  return (
    <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
      <h2 className="text-3xl font-black">Local CSV Exports</h2>
      <p className="mt-2 text-sm leading-6 text-neutral-500">
        Save business data directly from SQLite to a local folder, pen drive, or external disk.
      </p>
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
        {exports.map((item) => (
          <button
            key={item.slug}
            type="button"
            onClick={() => void runExport(item)}
            disabled={Boolean(active)}
            className="min-h-12 rounded-2xl border border-white/10 bg-black/35 px-4 text-sm font-black text-white disabled:opacity-50"
          >
            {active === item.slug ? "Saving..." : item.label}
          </button>
        ))}
      </div>
      {notice && <p className="mt-4 text-sm font-semibold text-cyan-100">{notice}</p>}
    </div>
  )
}
