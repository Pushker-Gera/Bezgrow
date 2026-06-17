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
  | "size_variants"
  | "color_variants"
  | "serial_numbers"
  | "warranty_tracking"
  | "prescription_required"
  | "prescription_upload"
  | "kot_printing"
  | "table_management"
  | "raw_materials"
  | "recipe_tracking"
  | "production_batches"
  | "service_invoices"
  | "weight_inventory"
  | "weight_tracking"
  | "purity_tracking"
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
  size_variants: {
    key: "size_variants",
    label: "Variants",
    description: "Size and variant-ready inventory structures.",
    category: "inventory",
    requiresPlan: "growth",
  },
  color_variants: {
    key: "color_variants",
    label: "Color variants",
    description: "Color-level product variants for catalog-heavy inventory.",
    category: "inventory",
    requiresPlan: "growth",
  },
  serial_numbers: {
    key: "serial_numbers",
    label: "Serial numbers",
    description: "Serialized stock control for devices, electronics, and warranty sales.",
    category: "inventory",
    requiresPlan: "growth",
  },
  warranty_tracking: {
    key: "warranty_tracking",
    label: "Warranty tracking",
    description: "Capture warranty-ready sales and service details.",
    category: "inventory",
    requiresPlan: "growth",
  },
  prescription_required: {
    key: "prescription_required",
    label: "Prescription required",
    description: "Medicine sale controls for prescription-only products.",
    category: "billing",
    requiresPlan: "growth",
  },
  prescription_upload: {
    key: "prescription_upload",
    label: "Prescription upload",
    description: "Attach prescription evidence to pharmacy billing.",
    category: "billing",
    requiresPlan: "growth",
    dependencies: ["prescription_required"],
  },
  kot_printing: {
    key: "kot_printing",
    label: "KOT printing",
    description: "Kitchen order ticket workflows for restaurant and cafe operations.",
    category: "orders",
    requiresPlan: "growth",
  },
  table_management: {
    key: "table_management",
    label: "Table management",
    description: "Table-aware ordering and billing for dine-in businesses.",
    category: "orders",
    requiresPlan: "growth",
  },
  raw_materials: {
    key: "raw_materials",
    label: "Raw materials",
    description: "Track input stock used for manufacturing, food, or assembled products.",
    category: "inventory",
    requiresPlan: "growth",
  },
  recipe_tracking: {
    key: "recipe_tracking",
    label: "Recipe tracking",
    description: "Connect recipes or bills of materials to stock consumption.",
    category: "inventory",
    requiresPlan: "growth",
    dependencies: ["raw_materials"],
  },
  production_batches: {
    key: "production_batches",
    label: "Production batches",
    description: "Batch manufactured goods with cost, quantity, and traceability.",
    category: "inventory",
    requiresPlan: "growth",
  },
  service_invoices: {
    key: "service_invoices",
    label: "Service invoices",
    description: "Service-led billing for consultants, repairs, agencies, and support teams.",
    category: "billing",
    requiresPlan: "starter",
  },
  weight_inventory: {
    key: "weight_inventory",
    label: "Weight inventory",
    description: "Weight-based stock for loose goods, grocery, jewellery, and bulk products.",
    category: "inventory",
    requiresPlan: "growth",
  },
  weight_tracking: {
    key: "weight_tracking",
    label: "Weight tracking",
    description: "Track sold and remaining quantity by weight units.",
    category: "inventory",
    requiresPlan: "growth",
    dependencies: ["weight_inventory"],
  },
  purity_tracking: {
    key: "purity_tracking",
    label: "Purity tracking",
    description: "Jewellery purity and material-grade tracking for high-value inventory.",
    category: "inventory",
    requiresPlan: "enterprise",
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
