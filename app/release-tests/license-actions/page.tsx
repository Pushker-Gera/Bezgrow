import { notFound } from "next/navigation"
import { LicenseActionFixture } from "@/app/release-tests/license-actions/LicenseActionFixture"

export const dynamic = "force-dynamic"

export default function LicenseActionsReleaseFixturePage() {
  if (process.env.BEZGROW_RELEASE_TEST !== "1") notFound()
  return <LicenseActionFixture />
}
