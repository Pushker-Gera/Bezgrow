import { redirect } from "next/navigation"

export default function LegacyPendingApprovalPage() {
  redirect("/offline?reason=license_required&next=/dashboard")
}
