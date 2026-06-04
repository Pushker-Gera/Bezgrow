export type PrintFormat = "thermal" | "a4" | "half-compact" | "half-top"
export type ThermalWidth = "58mm" | "80mm" | "auto"

export type PrintSettings = {
  defaultFormat: PrintFormat
  thermalWidth: ThermalWidth
  paperSize: "A4"
  margins: "compact" | "standard" | "wide"
  fontSize: "small" | "standard" | "large"
  showLogo: boolean
  showQr: boolean
  showBarcode: boolean
  showHsn: boolean
  showGstDetails: boolean
  showSignature: boolean
  showWatermark: boolean
  blackAndWhite: boolean
  pharmaMode: boolean
  autoPrintAfterSave: boolean
}

export type PrintEnterprise = {
  name: string
  businessType: string
  gstNumber: string
  drugLicense: string
  fssai: string
  phone: string
  email: string
  website: string
  address: string
  logoUrl: string
  branchName: string
}

export type PrintCustomer = {
  id: string
  name: string
  address: string
  phone: string
  gstin: string
  state: string
  stateCode: string
}

export type PrintInvoiceItem = {
  id: string
  name: string
  batchNumber: string
  manufacturingDate: string
  expiryDate: string
  scheduleType: string
  hsnCode: string
  quantity: number
  freeQuantity: number
  unit: string
  mrp: number
  rate: number
  discountPercent: number
  discountAmount: number
  taxableValue: number
  cgstPercent: number
  cgstAmount: number
  sgstPercent: number
  sgstAmount: number
  igstPercent: number
  igstAmount: number
  finalAmount: number
}

export type PrintPayment = {
  mode: string
  paidAmount: number
  dueAmount: number
  balanceAmount: number
  cashReceived: number
}

export type PrintTotals = {
  subtotal: number
  discount: number
  taxableAmount: number
  cgst: number
  sgst: number
  igst: number
  roundOff: number
  grandTotal: number
  amountInWords: string
}

export type PrintInvoice = {
  id: string
  invoiceNumber: string
  invoiceTitle: string
  invoiceDate: string
  dueDate: string
  salesperson: string
  enterprise: PrintEnterprise
  customer: PrintCustomer
  items: PrintInvoiceItem[]
  payment: PrintPayment
  totals: PrintTotals
  terms: string[]
  notes: string
  qrValue: string
  barcodeValue: string
  watermark: string
}
