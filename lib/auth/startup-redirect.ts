"use client"

import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { resolveDesktopStartupState } from "@/lib/startup/state-machine"

export async function resolveStartupRedirect(fallback = "/dashboard") {
  if (typeof window === "undefined") return ""

  if (!(await isTauriRuntimeAsync())) return "/download?erp=desktop_local_only"
  const resolution = await resolveDesktopStartupState(fallback)
  return resolution.redirectTo || (fallback === "/admin" ? "/dashboard" : fallback)
}
