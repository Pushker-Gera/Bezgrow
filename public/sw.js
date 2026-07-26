const CACHE_VERSION = "bezgrow-pwa-v6-admin-online-only-20260726"
const STATIC_CACHE = `${CACHE_VERSION}:static`
const SHELL_CACHE = `${CACHE_VERSION}:shell`

const SHELL_URLS = [
  "/",
  "/login",
  "/signup",
  "/offline",
  "/manifest.json",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon-48x48.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/maskable-icon-512x512.png",
  "/icons/icon-96.png",
  "/icons/icon-192.png",
  "/icons/maskable-512.png",
  "/icons/shortcut-dashboard.png"
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS))
  )
})

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting()
  }
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

function isStaticAsset(requestUrl) {
  return (
    requestUrl.pathname.startsWith("/_next/static/") ||
    requestUrl.pathname.startsWith("/icons/") ||
    requestUrl.pathname.startsWith("/screenshots/") ||
    requestUrl.pathname === "/favicon.ico" ||
    requestUrl.pathname === "/favicon-16x16.png" ||
    requestUrl.pathname === "/favicon-32x32.png" ||
    requestUrl.pathname === "/favicon-48x48.png" ||
    requestUrl.pathname === "/apple-touch-icon.png" ||
    requestUrl.pathname === "/icon-192.png" ||
    requestUrl.pathname === "/icon-512.png" ||
    requestUrl.pathname === "/android-chrome-192x192.png" ||
    requestUrl.pathname === "/android-chrome-512x512.png" ||
    requestUrl.pathname === "/maskable-icon-512x512.png" ||
    requestUrl.pathname === "/brand/bezgrow-logo-3d.png" ||
    requestUrl.pathname === "/brand/bezgrow-growth-logo.png" ||
    requestUrl.pathname === "/manifest.json" ||
    requestUrl.pathname === "/robots.txt" ||
    requestUrl.pathname === "/sitemap.xml"
  )
}

function isPrivateNavigation(requestUrl) {
  return (
    requestUrl.pathname.startsWith("/dashboard") ||
    requestUrl.pathname.startsWith("/admin") ||
    requestUrl.pathname.startsWith("/profile") ||
    requestUrl.pathname.startsWith("/create-business") ||
    requestUrl.pathname.startsWith("/public/invoices")
  )
}

function adminOfflineResponse() {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Platform Administration requires internet</title></head><body style="margin:0;background:#000;color:#fff;font-family:system-ui;display:grid;min-height:100vh;place-items:center"><main style="max-width:560px;padding:32px;text-align:center"><h1>Internet connection required for Platform Administration</h1><p style="color:#aaa;line-height:1.6">Admin pages and mutations are unavailable offline. The local Bezgrow ERP workspace is unchanged.</p></main></body></html>`,
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      },
    }
  )
}

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return

  const requestUrl = new URL(request.url)
  if (requestUrl.origin !== self.location.origin) return

  if (isStaticAsset(requestUrl)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) return cached

        const response = await fetch(request)
        if (response.ok) cache.put(request, response.clone())
        return response
      })
    )
    return
  }

  if (request.mode === "navigate") {
    if (requestUrl.pathname.startsWith("/admin")) {
      event.respondWith(
        fetch(request, { cache: "no-store" }).catch(() => adminOfflineResponse())
      )
      return
    }

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, response.clone()))
          }
          return response
        })
        .catch(async () => {
          if (isPrivateNavigation(requestUrl)) {
            return caches.match(request) || caches.match("/dashboard") || caches.match("/offline") || Response.error()
          }
          return caches.match(request) || caches.match("/") || caches.match("/offline") || Response.error()
        })
    )
  }
})
