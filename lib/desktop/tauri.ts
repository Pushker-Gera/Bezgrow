"use client"

type TauriWindow = Window & {
  __BEZGROW_DESKTOP__?: boolean
  __BEZGROW_RUNTIME__?: RuntimeMode
  __TAURI_INTERNALS__?: { invoke?: unknown }
  __TAURI__?: unknown
  isTauri?: boolean
}

type TauriGlobal = typeof globalThis & {
  __BEZGROW_DESKTOP__?: boolean
  __BEZGROW_RUNTIME__?: RuntimeMode
  __TAURI_INTERNALS__?: { invoke?: unknown }
  __TAURI__?: unknown
  isTauri?: boolean
}

export type RuntimeMode = "server" | "test" | "browser" | "tauri-dev" | "tauri-packaged"

let tauriRuntimePromise: Promise<boolean> | null = null

function testEnvironment() {
  return typeof process !== "undefined" && process.env.NODE_ENV === "test"
}

function injectedRuntimeMode() {
  if (typeof window === "undefined") return null
  const tauriWindow = window as TauriWindow
  const tauriGlobal = globalThis as TauriGlobal
  return tauriWindow.__BEZGROW_RUNTIME__ || tauriGlobal.__BEZGROW_RUNTIME__ || null
}

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

export function runtimeMode(): RuntimeMode {
  if (testEnvironment()) return "test"
  if (typeof window === "undefined") return "server"

  const injected = injectedRuntimeMode()
  if (injected) return injected

  if (isTauriRuntime()) {
    return window.location.port === "3000" ? "tauri-dev" : "tauri-packaged"
  }

  return "browser"
}

export async function detectRuntimeMode(): Promise<RuntimeMode> {
  const mode = runtimeMode()
  if (mode !== "browser") return mode
  return (await isTauriRuntimeAsync()) ? (window.location.port === "3000" ? "tauri-dev" : "tauri-packaged") : "browser"
}

export async function isDesktopRuntime() {
  const mode = await detectRuntimeMode()
  return mode === "tauri-dev" || mode === "tauri-packaged"
}

export async function isPackagedDesktopRuntime() {
  return (await detectRuntimeMode()) === "tauri-packaged"
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
