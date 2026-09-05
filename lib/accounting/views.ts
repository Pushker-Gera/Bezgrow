export type AccountingView = { id: string; label: string }
export type AccountingViewGroup = { label: string; views: readonly AccountingView[] }

export const accountingViewGroups: readonly AccountingViewGroup[] = [
  { label: "Overview", views: [{ id: "overview", label: "Overview" }] },
  {
    label: "Books",
    views: [
      { id: "chart-of-accounts", label: "Chart of Accounts" },
      { id: "journal", label: "Journal / Vouchers" },
      { id: "general-ledger", label: "General Ledger" },
      { id: "trial-balance", label: "Trial Balance" },
    ],
  },
  {
    label: "Sales & Receivables",
    views: [
      { id: "customer-receipts", label: "Customer Receipts" },
      { id: "receivables-aging", label: "Receivables Aging" },
      { id: "sales-register", label: "Sales Register" },
      { id: "credit-notes", label: "Credit Notes" },
    ],
  },
  {
    label: "Purchases & Payables",
    views: [
      { id: "purchases", label: "Purchases" },
      { id: "purchase-returns", label: "Purchase Returns" },
      { id: "supplier-payments", label: "Supplier Payments" },
      { id: "payables-aging", label: "Payables Aging" },
      { id: "purchase-register", label: "Purchase Register" },
      { id: "suppliers", label: "Suppliers" },
    ],
  },
  {
    label: "Banking",
    views: [
      { id: "bank-accounts", label: "Bank Accounts" },
      { id: "cash-book", label: "Cash Book" },
      { id: "bank-book", label: "Bank Book" },
      { id: "bank-reconciliation", label: "Bank Reconciliation" },
    ],
  },
  {
    label: "Tax",
    views: [
      { id: "gst-overview", label: "GST Overview" },
      { id: "gst-sales-register", label: "GST Sales Register" },
      { id: "gst-purchase-register", label: "GST Purchase Register" },
      { id: "gstr-1", label: "GSTR-1 Preparation" },
      { id: "gstr-3b", label: "GSTR-3B Preparation" },
      { id: "hsn-summary", label: "HSN/SAC Summary" },
      { id: "gst-validation", label: "GST Validation" },
    ],
  },
  {
    label: "Reports",
    views: [
      { id: "profit-loss", label: "Profit & Loss" },
      { id: "balance-sheet", label: "Balance Sheet" },
      { id: "cash-flow", label: "Cash Flow" },
      { id: "expenses", label: "Expenses" },
    ],
  },
  {
    label: "Setup",
    views: [
      { id: "opening-balances", label: "Opening Balances" },
      { id: "period-locking", label: "Period Locking" },
    ],
  },
] as const

export const accountingViews: readonly AccountingView[] = accountingViewGroups.flatMap((group) => [...group.views])

export type AccountingViewId = string

export function isAccountingView(value: string): value is AccountingViewId {
  return accountingViews.some((view) => view.id === value)
}
