import "server-only"

type DesktopOAuthExchange = {
  access_token: string
  refresh_token: string
  expires_at?: number
  expires_in?: number
  token_type?: string
  user?: unknown
  redirectTo: string
  expiresAt: number
}

type DesktopOAuthStoreGlobal = typeof globalThis & {
  __bezgrowDesktopOAuthExchanges?: Map<string, DesktopOAuthExchange>
}

const globalStore = globalThis as DesktopOAuthStoreGlobal

function getStore() {
  if (!globalStore.__bezgrowDesktopOAuthExchanges) {
    globalStore.__bezgrowDesktopOAuthExchanges = new Map()
  }

  return globalStore.__bezgrowDesktopOAuthExchanges
}

function pruneExpired() {
  const now = Date.now()
  const store = getStore()
  for (const [state, exchange] of store) {
    if (exchange.expiresAt <= now) store.delete(state)
  }
}

export function isValidDesktopOAuthState(state: string | null) {
  return Boolean(state && /^[a-f0-9]{48,96}$/i.test(state))
}

export function storeDesktopOAuthExchange(state: string, exchange: Omit<DesktopOAuthExchange, "expiresAt">) {
  if (!isValidDesktopOAuthState(state)) return false

  pruneExpired()
  getStore().set(state, {
    ...exchange,
    expiresAt: Date.now() + 5 * 60 * 1000,
  })
  return true
}

export function consumeDesktopOAuthExchange(state: string | null) {
  if (!state || !isValidDesktopOAuthState(state)) return null

  pruneExpired()
  const exchange = getStore().get(state)
  if (!exchange) return null

  getStore().delete(state)
  return exchange
}
