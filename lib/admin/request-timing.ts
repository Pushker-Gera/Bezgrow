import "server-only"

export function adminRequestTiming(route: string, method: string) {
  const startedAt = performance.now()
  let previousAt = startedAt
  const phases: Record<string, number> = {}

  return {
    mark(name: string) {
      const now = performance.now()
      phases[name] = Number((now - previousAt).toFixed(1))
      previousAt = now
    },
    finish(requestId: string) {
      if (process.env.NODE_ENV === "production") return
      console.info("[admin-request-timing]", {
        requestId,
        route,
        method,
        totalMs: Number((performance.now() - startedAt).toFixed(1)),
        phases,
      })
    },
  }
}
