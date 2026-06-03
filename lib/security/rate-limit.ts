import "server-only"

type RateLimitInput = {
  key: string
  limit: number
  windowMs: number
}

const buckets = new Map<string, { count: number; resetAt: number }>()

export function checkRateLimit(input: RateLimitInput) {
  const now = Date.now()
  const current = buckets.get(input.key)

  if (!current || current.resetAt <= now) {
    buckets.set(input.key, { count: 1, resetAt: now + input.windowMs })
    return { allowed: true, remaining: input.limit - 1, resetAt: now + input.windowMs }
  }

  if (current.count >= input.limit) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt }
  }

  current.count += 1
  return { allowed: true, remaining: input.limit - current.count, resetAt: current.resetAt }
}

export function rateLimitKey(request: Request, scope: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown"
  return `${scope}:${ip}`
}
