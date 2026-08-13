import "./globals.css"
import type { Metadata, Viewport } from "next"
import ChunkReloadGuard from "@/components/chunk-reload-guard"
import DesktopApiBridge from "@/components/desktop/DesktopApiBridge"
import DesktopAuthBridge from "@/components/desktop/DesktopAuthBridge"
import DesktopDatabaseBootstrap from "@/components/desktop/DesktopDatabaseBootstrap"
import EntryCalculatorAnimation from "@/components/EntryCalculatorAnimation"
import PwaRegistration from "@/components/PwaRegistration"
import WindowsTaskbarHelp from "@/components/desktop/WindowsTaskbarHelp"
import DesktopUpdateCoordinator from "@/components/desktop/DesktopUpdateCoordinator"

const siteUrl = "https://www.bezgrow.com"
const iconVersion = "20260701"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Bezgrow | Offline Billing & Inventory Software",
  description: "Professional local-first billing, invoicing and inventory management software for Windows and macOS. Works offline with business data stored on your computer.",
  applicationName: "Bezgrow",
  manifest: "/manifest.json",
  alternates: {
    canonical: "/",
  },
	  icons: {
	    icon: [
	      { url: `/favicon.ico?v=${iconVersion}`, sizes: "any" },
	      { url: `/favicon-32x32.png?v=${iconVersion}`, sizes: "32x32", type: "image/png" },
	      { url: `/favicon-16x16.png?v=${iconVersion}`, sizes: "16x16", type: "image/png" },
	      { url: `/favicon-48x48.png?v=${iconVersion}`, sizes: "48x48", type: "image/png" },
	      { url: `/icon-192.png?v=${iconVersion}`, sizes: "192x192", type: "image/png" },
	      { url: `/icon-512.png?v=${iconVersion}`, sizes: "512x512", type: "image/png" },
	      { url: `/android-chrome-192x192.png?v=${iconVersion}`, sizes: "192x192", type: "image/png" },
	      { url: `/android-chrome-512x512.png?v=${iconVersion}`, sizes: "512x512", type: "image/png" },
	    ],
	    shortcut: [`/favicon.ico?v=${iconVersion}`],
	    apple: [
	      { url: `/apple-touch-icon.png?v=${iconVersion}`, sizes: "180x180", type: "image/png" },
	    ],
	  },
  appleWebApp: {
    capable: true,
    title: "Bezgrow",
    statusBarStyle: "black-translucent",
    startupImage: [],
  },
  formatDetection: {
    telephone: false,
  },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: "Bezgrow",
    title: "Bezgrow | Offline Billing & Inventory Software",
    description: "Professional local-first billing, invoicing and inventory management software for Windows and macOS.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Bezgrow | Offline Billing & Inventory Software",
    description: "Professional local-first billing, invoicing and inventory management software for Windows and macOS.",
  },
  robots: {
    index: true,
    follow: true,
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-title": "Bezgrow",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
    "msapplication-TileColor": "#020617",
    "msapplication-tap-highlight": "no",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#06b6d4" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
  colorScheme: "dark light",
}

const structuredData = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Bezgrow",
    url: siteUrl,
    logo: `${siteUrl}/icon-512.png?v=${iconVersion}`,
    image: `${siteUrl}/icon-512.png?v=${iconVersion}`,
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Bezgrow",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Windows, macOS",
    url: siteUrl,
    description: "Local-first desktop billing, invoicing, GST-ready inventory and stock management software that works offline after licence activation.",
    publisher: {
      "@type": "Organization",
      name: "Bezgrow",
      url: siteUrl,
    },
  },
]

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {

  return (

    <html lang="en">

      <body>

        <ChunkReloadGuard />
        <DesktopApiBridge />
        <DesktopAuthBridge />
        <DesktopDatabaseBootstrap />
        <PwaRegistration />
        <EntryCalculatorAnimation />
        <WindowsTaskbarHelp />
        <DesktopUpdateCoordinator />

        {children}

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }}
        />

      </body>

    </html>

  )

}
