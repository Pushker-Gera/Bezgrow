import type { NextConfig } from "next";

const isDesktopBuild = process.env.BEZGROW_DESKTOP_BUILD === "1";
const desktopApiOrigin = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_DESKTOP_API_ORIGIN || process.env.NEXT_PUBLIC_SITE_URL || "").origin;
  } catch {
    return "";
  }
})();

const iconHeaders = [
  { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const iconSources = [
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon-48x48.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
  "/maskable-icon-512x512.png",
  "/brand/bezgrow-growth-logo.png",
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  ...(isDesktopBuild ? { output: "standalone" as const } : {}),
  images: {
    unoptimized: isDesktopBuild,
  },
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    "/*": ["./desktop-runtime/**/*", "./src-tauri/target/**/*"],
  },
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      ...iconSources.map((source) => ({
        source,
        headers: iconHeaders,
      })),
      {
        source: "/downloads/Bezgrow-mac.dmg",
        headers: [
          { key: "X-Bezgrow-Release-Status", value: "internal-testing" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/admin/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value:
              `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co${desktopApiOrigin ? ` ${desktopApiOrigin}` : ""}; frame-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self';`,
          },
        ],
      },
    ]
  },
};

export default nextConfig;
