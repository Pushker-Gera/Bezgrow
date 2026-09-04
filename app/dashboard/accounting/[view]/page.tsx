import { notFound } from "next/navigation"
import { AccountingWorkspace, accountingViews } from "@/components/accounting/AccountingWorkspace"

export default async function AccountingViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params
  if (!accountingViews.some((item) => item.id === view)) notFound()
  return <AccountingWorkspace view={view} />
}
