"use client"

export type SyncProgress = {
  total: number
  completed: number
  current?: string
  message: string
}

/**
 * Cloud ERP synchronization was retired when SQLite became the sole data
 * authority. The export is kept temporarily so an old caller cannot silently
 * upload queued business records after an application update.
 */
export async function syncOfflineQueue(onProgress?: (progress: SyncProgress) => void) {
  const message = "Cloud ERP synchronization is disabled. Your records remain in the local SQLite database."
  onProgress?.({ total: 0, completed: 0, message })
  return { completed: 0, unresolved: 0, disabled: true as const, message }
}
