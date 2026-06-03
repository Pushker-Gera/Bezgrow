export type FeatureKey =
  | "barcode_scanning"
  | "pos_billing"
  | "quick_checkout"
  | "bulk_pricing"
  | "gst_b2b"
  | "purchase_orders"
  | "shipping_labels"
  | "parcel_qr"
  | "awb_tracking"
  | "thermal_printing"
  | "warehouse_transfers"
  | "bulk_inventory"
  | "expiry_tracking"
  | "batch_tracking"
  | "quotation_system"
  | "credit_notes"
  | "debit_notes"
  | "payment_receipts"
  | "expense_tracking"
  | "supplier_ledger"
  | "customer_ledger"
  | "multi_currency"
  | "audit_logs"

export type FeatureCategory =
  | "inventory"
  | "billing"
  | "orders"
  | "accounting"
  | "admin"
  | "global"

export type FeatureDefinition = {
  key: FeatureKey
  label: string
  description: string
  category: FeatureCategory
  requiresPlan: "starter" | "growth" | "enterprise"
  dependencies?: FeatureKey[]
}

export const featureRegistry: Record<FeatureKey, FeatureDefinition> = {
  barcode_scanning: {
    key: "barcode_scanning",
    label: "Barcode scanning",
    description: "Scan SKU and barcode values for retail checkout and stock lookup.",
    category: "inventory",
    requiresPlan: "starter",
  },
  pos_billing: {
    key: "pos_billing",
    label: "POS billing",
    description: "Fast retail checkout with invoice and receipt workflows.",
    category: "billing",
    requiresPlan: "starter",
  },
  quick_checkout: {
    key: "quick_checkout",
    label: "Quick checkout",
    description: "Optimized one-screen sale flow for counters and malls.",
    category: "billing",
    requiresPlan: "starter",
  },
  bulk_pricing: {
    key: "bulk_pricing",
    label: "Bulk pricing",
    description: "Wholesale pricing and large quantity billing support.",
    category: "billing",
    requiresPlan: "growth",
  },
  gst_b2b: {
    key: "gst_b2b",
    label: "GST B2B invoices",
    description: "GST-ready invoice fields and tax reporting foundation.",
    category: "accounting",
    requiresPlan: "starter",
  },
  purchase_orders: {
    key: "purchase_orders",
    label: "Purchase orders",
    description: "Procurement workflow foundation for vendors and suppliers.",
    category: "orders",
    requiresPlan: "growth",
  },
  shipping_labels: {
    key: "shipping_labels",
    label: "Shipping labels",
    description: "Generate courier-ready labels for dispatch operations.",
    category: "orders",
    requiresPlan: "growth",
  },
  parcel_qr: {
    key: "parcel_qr",
    label: "Parcel QR",
    description: "QR-ready parcel and invoice handoff.",
    category: "orders",
    requiresPlan: "growth",
    dependencies: ["shipping_labels"],
  },
  awb_tracking: {
    key: "awb_tracking",
    label: "AWB tracking",
    description: "Courier tracking number support for orders.",
    category: "orders",
    requiresPlan: "growth",
  },
  thermal_printing: {
    key: "thermal_printing",
    label: "Thermal printing",
    description: "Receipt and label layouts for retail printers.",
    category: "billing",
    requiresPlan: "starter",
  },
  warehouse_transfers: {
    key: "warehouse_transfers",
    label: "Warehouse transfers",
    description: "Move stock between warehouses with an audit trail.",
    category: "inventory",
    requiresPlan: "growth",
  },
  bulk_inventory: {
    key: "bulk_inventory",
    label: "Bulk inventory",
    description: "Large stock catalog operations for distributors.",
    category: "inventory",
    requiresPlan: "growth",
  },
  expiry_tracking: {
    key: "expiry_tracking",
    label: "Expiry tracking",
    description: "Track product expiry and expiring-soon inventory.",
    category: "inventory",
    requiresPlan: "starter",
  },
  batch_tracking: {
    key: "batch_tracking",
    label: "Batch tracking",
    description: "Batch and lot tracking for regulated inventory.",
    category: "inventory",
    requiresPlan: "starter",
  },
  quotation_system: {
    key: "quotation_system",
    label: "Quotations",
    description: "Estimate and quotation foundation for pre-sales workflows.",
    category: "billing",
    requiresPlan: "growth",
  },
  credit_notes: {
    key: "credit_notes",
    label: "Credit notes",
    description: "Return and correction foundation for accounting workflows.",
    category: "accounting",
    requiresPlan: "growth",
  },
  debit_notes: {
    key: "debit_notes",
    label: "Debit notes",
    description: "Supplier adjustment foundation for accounting workflows.",
    category: "accounting",
    requiresPlan: "growth",
  },
  payment_receipts: {
    key: "payment_receipts",
    label: "Payment receipts",
    description: "Partial payment and receipt tracking foundation.",
    category: "accounting",
    requiresPlan: "starter",
  },
  expense_tracking: {
    key: "expense_tracking",
    label: "Expenses",
    description: "Expense register foundation for profit and loss reporting.",
    category: "accounting",
    requiresPlan: "growth",
  },
  supplier_ledger: {
    key: "supplier_ledger",
    label: "Vendor ledger",
    description: "Supplier payable and purchase ledger foundation.",
    category: "accounting",
    requiresPlan: "growth",
  },
  customer_ledger: {
    key: "customer_ledger",
    label: "Customer ledger",
    description: "Customer receivable and payment history foundation.",
    category: "accounting",
    requiresPlan: "growth",
  },
  multi_currency: {
    key: "multi_currency",
    label: "Multi-currency",
    description: "Currency and locale-ready billing foundation.",
    category: "global",
    requiresPlan: "enterprise",
  },
  audit_logs: {
    key: "audit_logs",
    label: "Audit logs",
    description: "Admin and business mutation logs for compliance.",
    category: "admin",
    requiresPlan: "starter",
  },
}

export const featureKeys = Object.keys(featureRegistry) as FeatureKey[]
