import { z } from "zod"

/**
 * Database concurrency tokens are opaque wire values. PostgreSQL can emit
 * timestamptz values with numeric offsets and microsecond precision, so they
 * must be validated without converting through JavaScript's millisecond Date.
 */
export const databaseDateTimeSchema = z.string().datetime({ offset: true })

/**
 * Machine timestamps may arrive from PostgreSQL with an explicit numeric
 * offset and microsecond precision. Accept RFC3339 input, then immediately
 * normalize it to the one representation Bezgrow signs and sends onward.
 */
export const canonicalUtcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())

/**
 * Newly signed machine timestamps have exactly one representation. Keeping
 * this stricter than the database input contract makes signing and verifying
 * operate on identical bytes on every locale and operating system.
 */
export const signedUtcDateTimeSchema = z.string().refine((value) => {
  const parsed = canonicalUtcDateTimeSchema.safeParse(value)
  return parsed.success && parsed.data === value
}, "Expected canonical RFC3339 UTC datetime with milliseconds (YYYY-MM-DDTHH:mm:ss.sssZ).")

export function canonicalUtcDateTime(value: string | Date) {
  const input = value instanceof Date ? value.toISOString() : value
  return canonicalUtcDateTimeSchema.parse(input)
}

export function isRfc3339DateTimeInput(value: unknown): value is string {
  return typeof value === "string" && databaseDateTimeSchema.safeParse(value).success
}

export function isCanonicalDateTimeInput(value: unknown): value is string {
  return typeof value === "string" && signedUtcDateTimeSchema.safeParse(value).success
}

export function timestampsRepresentSameInstant(left: string, right: string) {
  const leftResult = canonicalUtcDateTimeSchema.safeParse(left)
  const rightResult = canonicalUtcDateTimeSchema.safeParse(right)
  return leftResult.success && rightResult.success && leftResult.data === rightResult.data
}
