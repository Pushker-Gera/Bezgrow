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
      title="Offline inventory software for stock, batches, warehouses, and suppliers."
      description="Track product movement, low stock, batches, expiry dates, warehouses, purchase readiness, and inventory value locally on your Windows or Mac computer."
      highlights={["Stock tracking", "Batch and expiry", "Supplier records", "Warehouse movement", "Low-stock alerts", "Inventory valuation"]}
      workflows={["Create products", "Track stock movement", "Monitor inventory health"]}
      metrics={[["Storage", "Local"], ["Batches", "Ready"], ["Offline", "Yes"]]}
    />
  )
}
