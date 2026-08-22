export type InventoryRow = Record<string, unknown>

export type StockAllocation = {
  productId: string
  batchId: string | null
  batchNo: string | null
  warehouseId: string | null
  warehouseName: string
  quantity: number
}

export class InsufficientStockError extends Error {
  constructor(
    readonly productId: string,
    readonly available: number,
    readonly requested: number,
    readonly batchNo: string | null,
    readonly warehouseName: string
  ) {
    const location = warehouseName || "Main Warehouse"
    super(
      batchNo
        ? `Only ${available} units are available in Batch ${batchNo} at ${location}.`
        : `Only ${available} units are available at ${location}.`
    )
    this.name = "InsufficientStockError"
  }
}

function numberValue(value: unknown) {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function sameBatch(left: unknown, right: string) {
  return stringValue(left).toLocaleLowerCase("en-IN") === right.toLocaleLowerCase("en-IN")
}

function warehouseName(row: InventoryRow | undefined, product: InventoryRow) {
  return stringValue(row?.warehouse_name || row?.warehouse || product.warehouse_name || product.warehouse, "Main Warehouse")
}

export function authoritativeProductAvailability(product: InventoryRow, batches: InventoryRow[]) {
  const physical = Math.max(0, numberValue(product.stock))
  const activeBatches = batches.filter((batch) => batch.product_id === product.id && !batch.deleted_at && numberValue(batch.quantity) > 0)
  const batched = activeBatches.reduce((sum, batch) => sum + numberValue(batch.quantity), 0)
  return {
    physical,
    batched,
    unbatched: Math.max(0, physical - batched),
    consistent: batched <= physical + 0.0001,
  }
}

export function allocateAuthoritativeStock(
  products: InventoryRow[],
  batches: InventoryRow[],
  items: InventoryRow[],
  updatedAt: string
) {
  let nextBatches = batches.map((batch) => ({ ...batch }))
  const allocations: StockAllocation[] = []
  const remainingPhysical = new Map(products.map((product) => [String(product.id || ""), Math.max(0, numberValue(product.stock))]))

  for (const item of items) {
    const productId = stringValue(item.product_id)
    const product = products.find((candidate) => candidate.id === productId)
    const requestedBatch = stringValue(item.batch_no || item.batch_number)
    const requestedWarehouse = stringValue(item.warehouse_id)
    const requestedQuantity = Math.max(0, numberValue(item.quantity))
    if (!productId || !product || requestedQuantity <= 0) continue

    const availablePhysical = remainingPhysical.get(productId) || 0
    let remaining = requestedQuantity
    const lotsForProduct = nextBatches.filter((lot) => lot.product_id === productId && !lot.deleted_at && numberValue(lot.quantity) > 0)
    const eligibleLots = lotsForProduct
      .filter((lot) => (!requestedBatch || sameBatch(lot.batch_no, requestedBatch)) && (!requestedWarehouse || lot.warehouse_id === requestedWarehouse))
      .sort((left, right) => {
        const dateOrder = stringValue(left.purchase_date, stringValue(left.created_at, "9999")).localeCompare(
          stringValue(right.purchase_date, stringValue(right.created_at, "9999"))
        )
        return dateOrder || stringValue(left.id).localeCompare(stringValue(right.id))
      })

    let physicalAfter = availablePhysical
    for (const lot of eligibleLots) {
      if (remaining <= 0 || physicalAfter <= 0) break
      const quantity = Math.min(remaining, numberValue(lot.quantity), physicalAfter)
      if (quantity <= 0) continue
      remaining -= quantity
      physicalAfter -= quantity
      nextBatches = nextBatches.map((candidate) =>
        candidate.id === lot.id
          ? { ...candidate, quantity: Math.max(0, numberValue(candidate.quantity) - quantity), sync_status: "pending_update", updated_at: updatedAt }
          : candidate
      )
      allocations.push({
        productId,
        batchId: stringValue(lot.id) || null,
        batchNo: stringValue(lot.batch_no) || null,
        warehouseId: stringValue(lot.warehouse_id) || null,
        warehouseName: warehouseName(lot, product),
        quantity,
      })
    }

    const remainingLots = nextBatches
      .filter((lot) => lot.product_id === productId && !lot.deleted_at && numberValue(lot.quantity) > 0)
      .reduce((sum, lot) => sum + numberValue(lot.quantity), 0)
    const residualPhysical = Math.max(0, physicalAfter - remainingLots)
    const productBatchMatches = !requestedBatch || sameBatch(product.batch_no, requestedBatch)
    const productWarehouseMatches = !requestedWarehouse || product.warehouse_id === requestedWarehouse
    const residualAvailable = productBatchMatches && productWarehouseMatches ? residualPhysical : 0
    const residualQuantity = Math.min(remaining, residualAvailable)
    if (residualQuantity > 0) {
      remaining -= residualQuantity
      physicalAfter -= residualQuantity
      allocations.push({
        productId,
        batchId: null,
        batchNo: requestedBatch || stringValue(product.batch_no) || null,
        warehouseId: stringValue(product.warehouse_id) || null,
        warehouseName: warehouseName(undefined, product),
        quantity: residualQuantity,
      })
    }

    if (remaining > 0.0001) {
      const available = Math.max(0, requestedQuantity - remaining)
      const location = warehouseName(eligibleLots[0], product)
      throw new InsufficientStockError(productId, available, requestedQuantity, requestedBatch || null, location)
    }
    remainingPhysical.set(productId, Math.max(0, physicalAfter))
  }

  return { nextBatches, allocations }
}
