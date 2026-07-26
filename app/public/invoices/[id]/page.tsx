import { notFound } from "next/navigation"

export const dynamic = "force-dynamic"

export default function LegacyPublicInvoicePage() {
  // Raw invoice ids are not public capabilities. Secure shares use /i/{random-token}.
  notFound()
}
