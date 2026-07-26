import { redirect } from "next/navigation"

export default function LegacyRejectedAccessPage() {
  redirect("/offline?reason=license_required&next=/dashboard")
}
