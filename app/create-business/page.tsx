import { redirect } from "next/navigation"

export default function CreateBusiness() {
  redirect("/offline?reason=license_required&next=/dashboard")
}
