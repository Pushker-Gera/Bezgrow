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
      { id: "customer-statement", label: "Customer Statement" },
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
      { id: "supplier-statement", label: "Supplier Statement" },
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
      { id: "bank-statement-import", label: "Statement Import" },
    ],
  },
  {
    label: "Tax & GST",
    views: [
      { id: "gst-overview", label: "GST Overview" },
      { id: "gst-sales-register", label: "GST Sales Register" },
      { id: "gst-purchase-register", label: "GST Purchase Register" },
      { id: "gstr-1", label: "GSTR-1 Preparation" },
      { id: "gstr-3b", label: "GSTR-3B Preparation" },
      { id: "hsn-summary", label: "HSN/SAC Summary" },
      { id: "gst-validation", label: "GST Validation" },
      { id: "gst-return-preparation", label: "Return Preparation" },
      { id: "gst-reconciliation", label: "GST Reconciliation" },
      { id: "e-invoice", label: "E-Invoice" },
      { id: "e-way-bill", label: "E-Way Bill" },
      { id: "tds-register", label: "TDS" },
      { id: "tcs-register", label: "TCS" },
    ],
  },
  {
    label: "Assets & Analysis",
    views: [
      { id: "fixed-assets", label: "Fixed Assets" },
      { id: "depreciation-schedule", label: "Depreciation" },
      { id: "dimensions", label: "Cost Centres" },
      { id: "cost-centre-pl", label: "Cost Centre P&L" },
      { id: "department-pl", label: "Department P&L" },
      { id: "project-pl", label: "Project P&L" },
      { id: "budget-vs-actual", label: "Budgets" },
    ],
  },
  {
    label: "Reports",
    views: [
      { id: "profit-loss", label: "Profit & Loss" },
      { id: "balance-sheet", label: "Balance Sheet" },
      { id: "cash-flow", label: "Cash Flow" },
      { id: "expenses", label: "Expenses" },
      { id: "comparative-financials", label: "Comparative" },
      { id: "financial-insights", label: "Financial Insights" },
    ],
  },
  {
    label: "Professional",
    views: [
      { id: "accountant-workspace", label: "Accountant / CA" },
      { id: "auditor-mode", label: "Auditor Mode" },
      { id: "audit-trail", label: "Audit Trail" },
      { id: "accounting-health", label: "Accounting Health" },
      { id: "accounting-search", label: "Accounting Search" },
    ],
  },
  {
    label: "Setup",
    views: [
      { id: "opening-balances", label: "Opening Balances" },
      { id: "period-locking", label: "Period Locking" },
      { id: "voucher-numbering", label: "Voucher Numbering" },
    ],
  },
] as const

export const accountingViews: readonly AccountingView[] = accountingViewGroups.flatMap((group) => [...group.views])

export type AccountingViewId = string

export function isAccountingView(value: string): value is AccountingViewId {
  return accountingViews.some((view) => view.id === value)
}
