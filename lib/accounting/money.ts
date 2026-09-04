export class AccountingMoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AccountingMoneyError"
  }
}

type DecimalParts = {
  negative: boolean
  units: bigint
  scale: number
}

function numericText(value: unknown, label: string) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AccountingMoneyError(`${label} must be a valid amount.`)
    if (Math.abs(value) >= 1e21) throw new AccountingMoneyError(`${label} is outside the supported accounting range.`)
    return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "")
  }
  if (typeof value !== "string") throw new AccountingMoneyError(`${label} must be a valid amount.`)
  const normalized = value.trim().replaceAll(",", "")
  if (!normalized) throw new AccountingMoneyError(`${label} is required.`)
  return normalized
}

function decimalParts(value: unknown, label: string): DecimalParts {
  const text = numericText(value, label)
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) throw new AccountingMoneyError(`${label} must be a valid amount.`)
  const negative = text.startsWith("-")
  const unsigned = text.replace(/^[+-]/, "")
  const [whole, fraction = ""] = unsigned.split(".")
  return {
    negative,
    units: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  }
}

function roundedDivision(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  return remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient
}

function safeInteger(value: bigint, label: string) {
  const signed = Number(value)
  if (!Number.isSafeInteger(signed)) throw new AccountingMoneyError(`${label} is outside the supported accounting range.`)
  return signed
}

export function moneyToMinor(value: unknown, label = "Amount") {
  const parsed = decimalParts(value, label)
  const scale = BigInt(10) ** BigInt(parsed.scale)
  const absoluteMinor = roundedDivision(parsed.units * BigInt(100), scale)
  return safeInteger(parsed.negative ? -absoluteMinor : absoluteMinor, label)
}

export function multiplyMoneyToMinor(quantity: unknown, unitAmount: unknown, label = "Inventory cost") {
  const quantityParts = decimalParts(quantity, "Quantity")
  const amountParts = decimalParts(unitAmount, label)
  const denominator = BigInt(10) ** BigInt(quantityParts.scale + amountParts.scale)
  const absoluteMinor = roundedDivision(quantityParts.units * amountParts.units * BigInt(100), denominator)
  const negative = quantityParts.negative !== amountParts.negative
  return safeInteger(negative ? -absoluteMinor : absoluteMinor, label)
}

export function minorToMoney(minor: number) {
  if (!Number.isSafeInteger(minor)) throw new AccountingMoneyError("Stored accounting amount is invalid.")
  return minor / 100
}

export function assertNonNegativeMinor(minor: number, label = "Amount") {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new AccountingMoneyError(`${label} cannot be negative.`)
  return minor
}

export function formatMinor(minor: number, options: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
  }).format(minorToMoney(minor))
}
