import type { Metadata } from "next"
import HomeClient from "./home-client"

const siteUrl = "https://www.bezgrow.com"
const title = "Bezgrow | Offline Billing & Inventory Software"
const description =
  "Professional local-first billing, invoicing and inventory management software for Windows and macOS. Work offline with business data stored on your own computer."
const keywords = [
  "inventory management software",
  "GST billing software",
  "billing software",
  "ERP software",
  "retail POS software",
  "wholesale inventory management",
  "invoice software",
  "inventory tracking software",
  "business management software",
  "offline billing software",
  "desktop billing software",
  "billing software for Windows",
  "billing software for Mac",
  "offline inventory software",
  "local-first ERP",
]

export const metadata: Metadata = {
  title,
  description,
  keywords,
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    title,
    description,
    url: siteUrl,
    type: "website",
    siteName: "Bezgrow",
    images: [
      {
        url: `${siteUrl}/opengraph-image`,
        width: 1200,
        height: 630,
        alt: "Bezgrow offline billing and inventory management software for Windows and macOS",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [`${siteUrl}/opengraph-image`],
  },
  robots: {
    index: true,
    follow: true,
  },
}

const softwareApplicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Bezgrow",
  description,
  url: siteUrl,
  applicationCategory: "BusinessApplication",
  operatingSystem: "Windows, macOS",
  publisher: {
    "@type": "Organization",
    name: "Bezgrow",
    url: siteUrl,
  },
}

export default function Home() {
  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#020403] text-white">
      <HomeClient />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationSchema).replace(/</g, "\\u003c") }}
      />
    </main>
  )
}
