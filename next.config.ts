import type { NextConfig } from "next";

const isDesktopBuild = process.env.BEZGROW_DESKTOP_BUILD === "1";

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
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
          },
        ],
      },
    ]
  },
};

export default nextConfig;
