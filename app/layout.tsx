import "./globals.css"
import type { Metadata, Viewport } from "next"
import ChunkReloadGuard from "@/components/chunk-reload-guard"
import EntryCalculatorAnimation from "@/components/EntryCalculatorAnimation"
import PwaRegistration from "@/components/PwaRegistration"

const siteUrl = "https://bezgrow.com"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Bezgrow",
  description: "Cloud Inventory Management, Billing, POS and ERP Software",
  applicationName: "Bezgrow",
  manifest: "/manifest.json",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
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
    title: "Bezgrow",
    description: "Cloud Inventory Management, Billing, POS and ERP Software",
  },
  twitter: {
    card: "summary_large_image",
    title: "Bezgrow",
    description: "Cloud Inventory Management, Billing, POS and ERP Software",
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
    logo: `${siteUrl}/favicon.ico`,
    sameAs: [siteUrl],
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Bezgrow",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: siteUrl,
    description: "Cloud Inventory Management, Billing, POS and ERP Software",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "INR",
      availability: "https://schema.org/InStock",
    },
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
        <PwaRegistration />
        <EntryCalculatorAnimation />

        {children}

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }}
        />

      </body>

    </html>

  )

}
