import { notFound } from "next/navigation"
import { AccountingWorkspace } from "@/components/accounting/AccountingWorkspace"
import { isAccountingView } from "@/lib/accounting/views"

export default async function AccountingViewPage({ params }: { params: Promise<{ view: string }> }) {
  const { view } = await params
  if (!isAccountingView(view)) notFound()
  return <AccountingWorkspace view={view} />
}
