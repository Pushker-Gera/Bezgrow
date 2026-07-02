"use client"

type TauriWindow = Window & {
  __BEZGROW_DESKTOP__?: boolean
  __TAURI_INTERNALS__?: { invoke?: unknown }
  __TAURI__?: unknown
  isTauri?: boolean
}

type TauriGlobal = typeof globalThis & {
  __BEZGROW_DESKTOP__?: boolean
  __TAURI_INTERNALS__?: { invoke?: unknown }
  __TAURI__?: unknown
  isTauri?: boolean
}

let tauriRuntimePromise: Promise<boolean> | null = null

export function isTauriRuntime() {
  if (typeof window === "undefined") return false

  const tauriWindow = window as TauriWindow
  const tauriGlobal = globalThis as TauriGlobal

  return Boolean(
    tauriGlobal.__BEZGROW_DESKTOP__ ||
      tauriWindow.__BEZGROW_DESKTOP__ ||
      tauriGlobal.isTauri ||
      tauriWindow.isTauri ||
      tauriGlobal.__TAURI_INTERNALS__?.invoke ||
      tauriWindow.__TAURI_INTERNALS__?.invoke ||
      tauriGlobal.__TAURI__ ||
      tauriWindow.__TAURI__
  )
}

export async function isTauriRuntimeAsync() {
  if (isTauriRuntime()) return true
  if (tauriRuntimePromise) return tauriRuntimePromise

  tauriRuntimePromise = import("@tauri-apps/api/core")
    .then(({ isTauri }) => isTauri())
    .catch(() => false)

  return tauriRuntimePromise
}

export async function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
  const { invoke, isTauri } = await import("@tauri-apps/api/core")

  if (!isTauriRuntime() && !isTauri()) {
    throw new Error("Tauri runtime is not available.")
  }

  return invoke<T>(command, args)
}

export async function openExternalUrl(url: string) {
  if (!(await isTauriRuntimeAsync())) {
    window.location.assign(url)
    return false
  }

  await invokeTauri<void>("open_external_url", { url })
  return true
}
