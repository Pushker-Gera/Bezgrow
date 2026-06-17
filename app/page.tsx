import type { Metadata } from "next"
import HomeClient from "./home-client"

const siteUrl = "https://www.bezgrow.com"
const title = "Bezgrow | Inventory Management, GST Billing & ERP Software"
const description =
  "Bezgrow is a cloud-based inventory management, GST billing, retail POS and ERP software platform designed for retail, wholesale and service businesses."
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
        alt: "Bezgrow cloud inventory management, GST billing, POS and ERP software",
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
  operatingSystem: "Web",
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
