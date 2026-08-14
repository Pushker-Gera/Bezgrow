export type MoneyDisplay = {
  exact: string
  display: string
  compact: boolean
  length: number
}

function normalizedAmount(value: number) {
  return Number.isFinite(value) ? value : 0
}

function fractionDigits(value: number, precision: number) {
  return Number.isInteger(value) && precision > 0 ? 0 : precision
}

export function formatExactIndianMoney(value: number, precision = 0, currency = "INR") {
  const amount = normalizedAmount(value)
  const digits = fractionDigits(amount, precision)
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: digits,
    maximumFractionDigits: precision,
  }).format(amount)
}

function compactUnit(value: number) {
  const absolute = Math.abs(value)
  if (absolute >= 1_00_00_00_00_000) return { divisor: 1_00_00_00_00_000, suffix: "L Cr" }
  if (absolute >= 1_00_00_000) return { divisor: 1_00_00_000, suffix: "Cr" }
  if (absolute >= 1_00_000) return { divisor: 1_00_000, suffix: "L" }
  return { divisor: 1, suffix: "" }
}

export function formatCompactIndianMoney(value: number, precision = 2, currency = "INR") {
  const amount = normalizedAmount(value)
  const unit = compactUnit(amount)
  if (unit.divisor === 1) return formatExactIndianMoney(amount, precision, currency)
  const scaled = amount / unit.divisor
  const digits = Math.abs(scaled) >= 100 ? 1 : precision
  const symbol = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(scaled)
  return `${symbol} ${unit.suffix}`
}

export function moneyDisplay(value: number, options: { precision?: number; currency?: string; compactAt?: number } = {}): MoneyDisplay {
  const precision = options.precision ?? 0
  const currency = options.currency ?? "INR"
  const exact = formatExactIndianMoney(value, precision, currency)
  // Five-column desktop KPI grids leave roughly 180-220px per card. Indian
  // currency strings longer than eight characters wrap or clip at the intended
  // display size, so switch to lakh/crore notation before that can happen.
  // The exact accounting value remains available separately for assistive
  // technology and the native title tooltip.
  const compactAt = options.compactAt ?? 8
  const compact = exact.length > compactAt
  return {
    exact,
    display: compact ? formatCompactIndianMoney(value, Math.max(1, Math.min(2, precision || 2)), currency) : exact,
    compact,
    length: exact.length,
  }
}
