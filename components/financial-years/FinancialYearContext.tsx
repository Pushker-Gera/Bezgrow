"use client"

import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { apiFetch } from "@/lib/api/client-fetch"
import { selectedFinancialYearStorageKey } from "@/lib/offline/local/financial-years"
import { isoLocalDate, type FinancialYear } from "@/lib/financial-years"

type FinancialYearContextValue = {
  years: FinancialYear[]
  activeYear: FinancialYear | null
  selectedYear: FinancialYear | null
  loading: boolean
  error: string
  selectYear: (id: string) => void
  refresh: () => Promise<void>
}

const FinancialYearContext = createContext<FinancialYearContextValue | null>(null)

export function FinancialYearProvider({ organizationId, children }: { organizationId: string; children: ReactNode }) {
  const [years, setYears] = useState<FinancialYear[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  async function refresh() {
    if (!organizationId) return
    try {
      setLoading(true)
      const response = await apiFetch(`/api/financial-years/list?organization_id=${encodeURIComponent(organizationId)}`, { cache: "no-store" })
      const payload = (await response.json()) as { years?: FinancialYear[]; error?: string }
      if (!response.ok) throw new Error(payload.error || "Financial years failed to load.")
      const nextYears = payload.years || []
      const stored = localStorage.getItem(selectedFinancialYearStorageKey(organizationId)) || localStorage.getItem("bezgrow:selected-financial-year") || ""
      const nextSelected = nextYears.find((year) => year.id === (selectedId || stored)) || nextYears.find((year) => Boolean(year.is_active)) || nextYears[0] || null
      setYears(nextYears)
      setSelectedId(nextSelected?.id || "")
      if (nextSelected) {
        localStorage.setItem(selectedFinancialYearStorageKey(organizationId), nextSelected.id)
        localStorage.setItem("bezgrow:selected-financial-year", nextSelected.id)
      }
      setError("")
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Financial years failed to load.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // The provider reloads when the licensed business changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId])

  function selectYear(id: string) {
    if (!id || id === selectedId) return
    setSelectedId(id)
    localStorage.setItem(selectedFinancialYearStorageKey(organizationId), id)
    localStorage.setItem("bezgrow:selected-financial-year", id)
    window.dispatchEvent(new CustomEvent("bezgrow:financial-year-changed", { detail: { financialYearId: id } }))
  }

  const value = useMemo<FinancialYearContextValue>(() => ({
    years,
    activeYear: years.find((year) => Boolean(year.is_active)) || null,
    selectedYear: years.find((year) => year.id === selectedId) || null,
    loading,
    error,
    selectYear,
    refresh,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [error, loading, selectedId, years])

  return <FinancialYearContext.Provider value={value}>{children}</FinancialYearContext.Provider>
}

export function useFinancialYears() {
  const value = useContext(FinancialYearContext)
  if (!value) throw new Error("Financial year context is not available.")
  return value
}

export function FinancialYearSelector({ compact = false }: { compact?: boolean }) {
  const { years, selectedYear, loading, error, selectYear } = useFinancialYears()
  if (loading) return <span className="text-xs font-bold text-neutral-500">Loading FY…</span>
  if (error) return <span className="text-xs font-bold text-amber-200" title={error}>FY unavailable</span>
  if (!selectedYear) return null
  return (
    <label className={`flex items-center gap-2 rounded-xl border border-cyan-400/20 bg-cyan-500/10 ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}>
      <span className="sr-only">Financial Year</span>
      <select
        aria-label="Financial Year"
        value={selectedYear.id}
        onChange={(event) => selectYear(event.target.value)}
        className="max-w-40 bg-transparent text-xs font-black text-cyan-100 outline-none"
      >
        {years.map((year) => (
          <option key={year.id} value={year.id} className="bg-neutral-950 text-white">
            {year.label} · {year.is_active ? "Current active" : year.start_date > isoLocalDate() ? "Future · unavailable" : year.status === "CLOSED" ? "Closed" : year.status === "ARCHIVED" ? "Archived" : "Historical open"}
          </option>
        ))}
      </select>
    </label>
  )
}

export function FinancialYearViewingBanner() {
  const { selectedYear, activeYear } = useFinancialYears()
  if (!selectedYear || selectedYear.id === activeYear?.id) return null
  return (
    <div className="border-b border-amber-400/20 bg-amber-500/10 px-4 py-2 text-center text-xs font-bold text-amber-100">
      Viewing {selectedYear.label} — {selectedYear.start_date > isoLocalDate() ? "Future year unavailable" : selectedYear.status === "CLOSED" ? "Closed · read-only" : "Historical year · new transactions are read-only"}. Period figures use this year; product master and physical stock remain current.
    </div>
  )
}

export function FinancialYearScopedContent({ children }: { children: ReactNode }) {
  const { selectedYear } = useFinancialYears()
  return <Fragment key={selectedYear?.id || "financial-year-loading"}>{children}</Fragment>
}
