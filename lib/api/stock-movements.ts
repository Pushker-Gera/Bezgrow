import "server-only"
import { adminSupabase } from "@/lib/supabase/admin"

type StockMovementPayload = Record<string, string | number | null>

function missingColumnFromError(error: { message?: string | null } | null) {
  if (!error?.message) return null
  const match =
    error.message.match(/Could not find the '([^']+)' column/i) ||
    error.message.match(/column "([^"]+)" of relation/i) ||
    error.message.match(/column "([^"]+)" does not exist/i)

  return match?.[1] || null
}

export async function insertStockMovement(payload: StockMovementPayload) {
  const retryPayload = { ...payload }
  const removedColumns: string[] = []

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await adminSupabase.from("stock_movements").insert(retryPayload)
    const missingColumn = missingColumnFromError(result.error)

    if (!result.error || !missingColumn || !(missingColumn in retryPayload)) {
      return { ...result, removedColumns }
    }

    delete retryPayload[missingColumn]
    removedColumns.push(missingColumn)
  }

  const result = await adminSupabase.from("stock_movements").insert(retryPayload)
  return { ...result, removedColumns }
}
