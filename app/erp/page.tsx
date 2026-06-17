import type { Metadata } from "next"
import { FeaturePage } from "@/components/marketing/FeaturePage"

export const metadata: Metadata = {
  title: "ERP Software for Businesses | Bezgrow",
  description: "Use Bezgrow ERP for inventory, billing, customers, analytics, admin approvals, settings, and business operations.",
  alternates: { canonical: "https://www.bezgrow.com/erp" },
}

export default function ErpPage() {
  return (
    <FeaturePage
      eyebrow="Business ERP"
      title="ERP software that connects inventory, billing, customers, analytics, and admin control."
      description="Bring daily operations together with business workspaces, approval flows, role-aware access, analytics, customer records, and professional billing output."
      highlights={["Business workspace", "Admin approval", "Customer CRM", "Analytics dashboard", "Role control", "Launch readiness"]}
      workflows={["Manage workspace", "Control operations", "Analyze business health"]}
      metrics={[["Workspace", "Cloud"], ["Admin", "Control"], ["Reports", "Live"]]}
    />
  )
}
