"use client"

import { cacheWorkspaceBootstrap, getCachedWorkspaceBootstrap } from "@/lib/offline/db"

export type WorkspaceBootstrapPayload = {
  success: boolean
  error?: string
  user?: {
    id?: string
    email?: string | null
  }
  profile?: {
    id?: string
    role?: string | null
    approved?: boolean
    is_suspended?: boolean
    business_created?: boolean
  }
  organization?: {
    id?: string | null
    name?: string | null
    currency?: string | null
    timezone?: string | null
    locale?: string | null
    business_type?: string | null
    business_category?: string | null
  } | null
  membership?: {
    organization_id?: string | null
    role?: string | null
  } | null
  features?: string[]
  currency?: string
  timezone?: string
  locale?: string
  permissions?: {
    admin?: boolean
    canAccessDashboard?: boolean
    canManageBilling?: boolean
  }
}

type CachedWorkspace = {
  value: WorkspaceBootstrapPayload
  expiresAt: number
}

const CACHE_KEY = "bezgrow:workspace-bootstrap"
const CACHE_TTL_MS = 120000

let inFlight: Promise<WorkspaceBootstrapPayload | null> | null = null

function readCache() {
  if (typeof window === "undefined") return null

  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null") as CachedWorkspace | null
    if (cached?.expiresAt && cached.expiresAt > Date.now()) return cached.value
  } catch {
    sessionStorage.removeItem(CACHE_KEY)
  }

  return null
}

function writeCache(value: WorkspaceBootstrapPayload) {
  if (typeof window === "undefined") return
  sessionStorage.setItem(CACHE_KEY, JSON.stringify({ value, expiresAt: Date.now() + CACHE_TTL_MS }))
}

export function clearWorkspaceBootstrapCache() {
  inFlight = null
  if (typeof window !== "undefined") {
    sessionStorage.removeItem(CACHE_KEY)
    sessionStorage.removeItem("bezgrow:organization-id")
  }
}

export async function getWorkspaceBootstrap(options: { forceFresh?: boolean } = {}) {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const offlineCached = getCachedWorkspaceBootstrap()
    if (offlineCached) return offlineCached
  }

  if (!options.forceFresh) {
    const cached = readCache()
    if (cached) return cached
    if (inFlight) return inFlight
  }

  inFlight = fetch("/api/workspace/bootstrap", {
    credentials: "include",
    cache: options.forceFresh ? "no-store" : "default",
  })
    .then(async (response) => {
      const payload = (await response.json()) as WorkspaceBootstrapPayload
      if (response.ok && payload.success) {
        writeCache(payload)
        await cacheWorkspaceBootstrap(payload)
      }
      if (!response.ok && typeof navigator !== "undefined" && !navigator.onLine) {
        return getCachedWorkspaceBootstrap()
      }
      return payload
    })
    .catch(() => {
      const cached = getCachedWorkspaceBootstrap()
      if (cached && typeof navigator !== "undefined" && !navigator.onLine) return cached
      return null
    })
    .finally(() => {
      inFlight = null
    })

  return inFlight
}
