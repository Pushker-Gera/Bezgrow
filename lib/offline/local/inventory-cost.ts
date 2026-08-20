export type InventoryCostProduct = {
  id?: unknown
  stock?: unknown
  purchase_rate?: unknown
  deleted_at?: unknown
}

export type InventoryCostBatch = {
  id?: unknown
  product_id?: unknown
  quantity?: unknown
  purchase_rate?: unknown
  purchase_date?: unknown
  created_at?: unknown
  deleted_at?: unknown
}

function finiteNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function optionalNonNegativeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function sortableDate(value: unknown) {
  return typeof value === "string" && value.trim() ? value : "9999-12-31T23:59:59.999Z"
}

/**
 * Values current stock from receipt lots in FIFO order. Legacy stock that has no
 * matching lot is valued at the product's purchase rate. Calculations keep full
 * precision; presentation is responsible for rounding.
 */
export function calculateInventoryCost(products: InventoryCostProduct[], batches: InventoryCostBatch[]) {
  const lotsByProduct = new Map<string, InventoryCostBatch[]>()

  for (const batch of batches) {
    if (batch.deleted_at || finiteNumber(batch.quantity) <= 0) continue
    const productId = String(batch.product_id || "")
    if (!productId) continue
    const lots = lotsByProduct.get(productId) || []
    lots.push(batch)
    lotsByProduct.set(productId, lots)
  }

  for (const lots of lotsByProduct.values()) {
    lots.sort((left, right) => {
      const dateOrder = sortableDate(left.purchase_date || left.created_at).localeCompare(sortableDate(right.purchase_date || right.created_at))
      return dateOrder || String(left.id || "").localeCompare(String(right.id || ""))
    })
  }

  let total = 0
  for (const product of products) {
    if (product.deleted_at) continue
    const productId = String(product.id || "")
    let remaining = Math.max(0, finiteNumber(product.stock))
    const fallbackRate = Math.max(0, finiteNumber(product.purchase_rate))

    for (const lot of lotsByProduct.get(productId) || []) {
      if (remaining <= 0) break
      const valuedQuantity = Math.min(remaining, Math.max(0, finiteNumber(lot.quantity)))
      const rawRate = optionalNonNegativeNumber(lot.purchase_rate)
      total += valuedQuantity * (rawRate ?? fallbackRate)
      remaining -= valuedQuantity
    }

    total += remaining * fallbackRate
  }

  return total
}
