"use client"

import type { ReactNode } from "react"
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"
import { downloadAdminFile, secureAdminFetch } from "@/lib/platform-admin/client"

type OnlineContextValue = {
  online: boolean
}

const OnlineContext = createContext<OnlineContextValue>({ online: true })
const activeAdminMutations = new Set<string>()

export function AdminOnlineProvider({ online, children }: { online: boolean; children: ReactNode }) {
  return <OnlineContext.Provider value={{ online }}>{children}</OnlineContext.Provider>
}

export function useAdminOnline() {
  return useContext(OnlineContext)
}

type ListPayload<T> = {
  success?: boolean
  data?: T[]
  pagination?: {
    page: number
    limit: number
    total: number
  }
  error?: string
  requestId?: string
} & Record<string, unknown>

export function useAdminList<T extends Record<string, unknown>>(
  endpoint: string,
  filters: Record<string, string> = {}
) {
  const { online } = useAdminOnline()
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [metadata, setMetadata] = useState<Record<string, unknown>>({})
  const [reloadToken, setReloadToken] = useState(0)
  const requestRef = useRef<AbortController | null>(null)
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 300)
    return () => globalThis.clearTimeout(timeout)
  }, [search])

  useEffect(() => {
    if (!online) {
      requestRef.current?.abort()
      queueMicrotask(() => {
        setLoading(false)
        setError("Internet connection required for Platform Administration")
      })
      return
    }

    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const parsedFilters = JSON.parse(filterKey) as Record<string, string>
    const params = new URLSearchParams({
      page: String(page),
      limit: "25",
      search: debouncedSearch,
      ...parsedFilters,
    })
    queueMicrotask(() => {
      setLoading(true)
      setError("")
    })

    secureAdminFetch(`${endpoint}?${params}`, {
      cache: "no-store",
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as ListPayload<T>
        if (!response.ok || !payload.success) {
          if (response.status === 401) {
            window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}&platform_admin=1`)
            return null
          }
          throw new Error(payload.error || `Request failed (${response.status}).`)
        }
        return payload
      })
      .then((payload) => {
        if (!payload) return
        setData(payload.data || [])
        setTotal(payload.pagination?.total || 0)
        const { data: _data, pagination: _pagination, ...rest } = payload
        void _data
        void _pagination
        setMetadata(rest)
      })
      .catch((requestError) => {
        if (controller.signal.aborted) return
        const message = requestError instanceof Error ? requestError.message : ""
        setError(
          /fetch|network|load failed/i.test(message)
            ? "Internet connection required for Platform Administration"
            : message || "The page could not be loaded."
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [debouncedSearch, endpoint, filterKey, online, page, reloadToken])

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])
  const prepend = useCallback((row: T) => {
    setData((current) => [row, ...current.filter((item) => item.id !== row.id)].slice(0, 25))
    setTotal((current) => current + (data.some((item) => item.id === row.id) ? 0 : 1))
  }, [data])
  const upsert = useCallback((row: T) => {
    setData((current) => current.some((item) => item.id === row.id)
      ? current.map((item) => item.id === row.id ? row : item)
      : [row, ...current].slice(0, 25))
  }, [])
  return { data, loading, error, search, setSearch, page, setPage, total, metadata, reload, prepend, upsert }
}

export async function adminMutation<T = Record<string, unknown>>(
  endpoint: string,
  method: "POST" | "PATCH",
  body: unknown
) {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Internet connection required for Platform Administration")
  }
  const mutationKey = `${method}:${endpoint}:${JSON.stringify(body)}`
  if (activeAdminMutations.has(mutationKey)) {
    throw new Error("This action is already being submitted.")
  }
  activeAdminMutations.add(mutationKey)

  let response: Response
  try {
    response = await secureAdminFetch(endpoint, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error("Internet connection required for Platform Administration")
  } finally {
    activeAdminMutations.delete(mutationKey)
  }
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean
    error?: string
    requestId?: string
  } & T
  if (!response.ok || !payload.success) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.assign(
        `/login?next=${encodeURIComponent(window.location.pathname)}&platform_admin=1&error=session_expired`
      )
      throw new Error("Admin authorization expired")
    }
    const suffix = payload.requestId ? ` Request ID: ${payload.requestId}` : ""
    throw new Error(`${payload.error || "The change could not be completed."}${suffix}`)
  }
  return payload
}

export function AdminPageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan-200">{eyebrow}</p>
        <h2 className="mt-3 text-3xl font-black sm:text-4xl">{title}</h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-neutral-400">{description}</p>
      </div>
      {action}
    </header>
  )
}

export function AdminNotice({
  children,
  tone = "info",
}: {
  children: ReactNode
  tone?: "info" | "warning" | "danger" | "success"
}) {
  const className = {
    info: "border-cyan-400/20 bg-cyan-500/10 text-cyan-100",
    warning: "border-amber-400/20 bg-amber-500/10 text-amber-100",
    danger: "border-red-400/20 bg-red-500/10 text-red-100",
    success: "border-emerald-400/20 bg-emerald-500/10 text-emerald-100",
  }[tone]
  return <div className={`rounded-2xl border px-4 py-3 text-sm ${className}`}>{children}</div>
}

export function StatusPill({ value }: { value: unknown }) {
  const label = String(value || "not reported").replaceAll("_", " ")
  const normalized = label.toLowerCase()
  const color =
    normalized.includes("active") ||
    normalized.includes("valid") ||
    normalized.includes("ready") ||
    normalized.includes("published") ||
    normalized.includes("success")
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
      : normalized.includes("expired") ||
          normalized.includes("revoked") ||
          normalized.includes("invalid") ||
          normalized.includes("failed") ||
          normalized.includes("urgent")
        ? "border-red-400/25 bg-red-400/10 text-red-200"
        : normalized.includes("pending") ||
            normalized.includes("grace") ||
            normalized.includes("paused") ||
            normalized.includes("attention")
          ? "border-amber-400/25 bg-amber-400/10 text-amber-100"
          : "border-white/10 bg-white/[0.05] text-neutral-300"

  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${color}`}>
      {label}
    </span>
  )
}

export function formatAdminDate(value: unknown, fallback = "Never") {
  if (!value) return fallback
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString()
}

export function displayValue(value: unknown, fallback = "Not configured") {
  if (value === null || value === undefined || value === "") return fallback
  return String(value)
}

export function AdminTable({
  columns,
  rows,
  loading,
  error,
  empty,
}: {
  columns: Array<{
    key: string
    label: string
    render?: (row: Record<string, unknown>) => ReactNode
  }>
  rows: Array<Record<string, unknown>>
  loading: boolean
  error: string
  empty: string
}) {
  if (loading) {
    return (
      <div className="grid gap-3 rounded-[28px] border border-white/10 bg-white/[0.025] p-5">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="h-16 animate-pulse rounded-2xl bg-white/[0.06]" />
        ))}
      </div>
    )
  }
  if (error) return <AdminNotice tone="danger">{error}</AdminNotice>
  if (!rows.length) {
    return (
      <div className="rounded-[28px] border border-dashed border-white/15 bg-white/[0.02] px-6 py-14 text-center text-sm text-neutral-400">
        {empty}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.025]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="border-b border-white/10 bg-white/[0.035] text-[11px] uppercase tracking-[0.12em] text-neutral-500">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className="px-4 py-4 font-black">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.id || index)} className="border-b border-white/[0.07] last:border-0 hover:bg-white/[0.025]">
                {columns.map((column) => (
                  <td key={column.key} className="max-w-[300px] px-4 py-4 align-top text-neutral-300">
                    {column.render ? column.render(row) : displayValue(row[column.key], "Not reported")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function AdminListControls({
  search,
  onSearch,
  filters,
  exportHref,
}: {
  search: string
  onSearch: (value: string) => void
  filters?: ReactNode
  exportHref?: string
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[24px] border border-white/10 bg-white/[0.025] p-3 sm:flex-row">
      <input
        value={search}
        onChange={(event) => onSearch(event.target.value)}
        placeholder="Search…"
        className="h-11 min-w-0 flex-1 rounded-2xl border border-white/10 bg-black/40 px-4 text-sm outline-none placeholder:text-neutral-600 focus:border-cyan-400/40"
      />
      {filters}
      {exportHref && <AdminExportLink href={exportHref} compact />}
    </div>
  )
}

export function AdminExportLink({ href, compact = false }: { href: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void downloadAdminFile(href).catch((error) => {
          window.alert(error instanceof Error ? error.message : "The admin export could not be downloaded.")
        }).finally(() => setBusy(false))
      }}
      className={`flex items-center justify-center rounded-2xl border border-white/10 px-5 text-sm font-black disabled:opacity-50 ${compact ? "h-11" : "h-12"}`}
    >
      {busy ? "Exporting…" : "Export CSV"}
    </button>
  )
}

export function AdminPagination({
  page,
  total,
  limit = 25,
  onPage,
}: {
  page: number
  total: number
  limit?: number
  onPage: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / limit))
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-neutral-400">
      <span>
        Page {page} of {pages} · {total.toLocaleString()} records
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="h-10 rounded-xl border border-white/10 px-4 font-bold text-white disabled:opacity-30"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          className="h-10 rounded-xl border border-white/10 px-4 font-bold text-white disabled:opacity-30"
        >
          Next
        </button>
      </div>
    </div>
  )
}

export function AdminModal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose, open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <section className="max-h-[90dvh] w-full max-w-3xl overflow-y-auto rounded-[30px] border border-white/15 bg-[#080b0b] p-5 shadow-2xl sm:p-7">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-2xl font-black">{title}</h3>
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-white/10 px-4 text-sm font-black">
            Close
          </button>
        </div>
        <div className="mt-6">{children}</div>
      </section>
    </div>
  )
}
