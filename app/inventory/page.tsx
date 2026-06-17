import type { Metadata } from "next"
import { FeaturePage } from "@/components/marketing/FeaturePage"

export const metadata: Metadata = {
  title: "Inventory Management Software | Bezgrow",
  description: "Manage stock, batches, suppliers, warehouses, expiry tracking, low stock alerts, and inventory movement with Bezgrow.",
  alternates: { canonical: "https://www.bezgrow.com/inventory" },
}

export default function InventoryPage() {
  return (
    <FeaturePage
      eyebrow="Inventory management"
      title="Cloud inventory software for stock, batches, warehouses, and suppliers."
      description="Track product movement, low stock, batches, expiry dates, warehouses, purchase readiness, and inventory value from one fast business workspace."
      highlights={["Stock tracking", "Batch and expiry", "Supplier records", "Warehouse movement", "Low-stock alerts", "Inventory valuation"]}
      workflows={["Create products", "Track stock movement", "Monitor inventory health"]}
      metrics={[["Stock", "Realtime"], ["Batches", "Ready"], ["Warehouses", "Multi"]]}
    />
  )
}
