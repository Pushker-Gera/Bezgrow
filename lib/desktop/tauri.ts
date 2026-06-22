"use client"

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: unknown
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as TauriWindow)
}

export async function invokeTauri<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauriRuntime()) {
    throw new Error("Tauri runtime is not available.")
  }

  const { invoke } = await import("@tauri-apps/api/core")
  return invoke<T>(command, args)
}
