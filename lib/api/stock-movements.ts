import "server-only"

export type StockMovementPayload = Record<string, unknown>

/** @deprecated Stock movements are written atomically by the local SQLite ERP repository. */
export async function insertStockMovement(payload: StockMovementPayload) {
  void payload
  throw new Error("Cloud stock movement writes are disabled. Use the local SQLite ERP repository.")
}
