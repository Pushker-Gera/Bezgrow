import { z } from "zod"

/**
 * Machine timestamps may arrive from PostgreSQL with an explicit numeric
 * offset and microsecond precision. Accept RFC3339 input, then immediately
 * normalize it to the one representation Bezgrow signs and sends onward.
 */
export const canonicalUtcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

export function canonicalUtcDateTime(value: string | Date) {
  const input = value instanceof Date ? value.toISOString() : value
  return canonicalUtcDateTimeSchema.parse(input)
}

export function isCanonicalDateTimeInput(value: unknown): value is string {
  return typeof value === "string" && canonicalUtcDateTimeSchema.safeParse(value).success
}

export function timestampsRepresentSameInstant(left: string, right: string) {
  const leftResult = canonicalUtcDateTimeSchema.safeParse(left)
  const rightResult = canonicalUtcDateTimeSchema.safeParse(right)
  return leftResult.success && rightResult.success && leftResult.data === rightResult.data
}
