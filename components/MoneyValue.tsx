import { moneyDisplay } from "@/lib/money-format"

export function MoneyValue({
  value,
  precision = 0,
  currency = "INR",
  compactAt = 8,
  className = "",
}: {
  value: number
  precision?: number
  currency?: string
  compactAt?: number
  className?: string
}) {
  const formatted = moneyDisplay(value, { precision, currency, compactAt })
  const responsiveSize = formatted.compact
    ? "text-[clamp(1.35rem,2.4vw,2.25rem)]"
    : formatted.length > 12
      ? "text-[clamp(1.25rem,2.15vw,2rem)]"
      : "text-[clamp(1.5rem,2.7vw,2.5rem)]"

  return (
    <span
      className={`block w-full min-w-0 max-w-full overflow-hidden whitespace-nowrap leading-none tracking-tight ${responsiveSize} ${className}`}
      title={formatted.exact}
      aria-label={formatted.exact}
      data-money-value="true"
      data-display-mode={formatted.compact ? "compact" : "exact"}
    >
      <span aria-hidden="true">{formatted.display}</span>
      <span className="sr-only">Exact amount: {formatted.exact}</span>
    </span>
  )
}
