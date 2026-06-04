import "./globals.css"
import type { Metadata } from "next"
import ChunkReloadGuard from "@/components/chunk-reload-guard"

const siteUrl = "https://bezgrow.com"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Bezgrow",
  description: "Cloud Inventory Management, Billing, POS and ERP Software",
  applicationName: "Bezgrow",
  alternates: {
    canonical: "/",
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

        {children}

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }}
        />

      </body>

    </html>

  )

}
