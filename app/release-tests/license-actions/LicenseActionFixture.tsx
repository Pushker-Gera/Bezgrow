"use client"

import { useState } from "react"
import { LicenseActionButtons } from "@/components/admin/LicenseActionButtons"
import { LicenseActionDialog } from "@/components/admin/LicenseActionDialog"
import type { AdminLicenseAction, ValidUpdateLicenseInput } from "@/lib/license/admin-license-validation"

const fixtureRow: Record<string, unknown> = {
  id: "LIC-INTERACTION-FIXTURE-0001",
  customer_name: "Interaction Fixture Customer",
  customer_email: "fixture@example.test",
  business_name: "Interaction Fixture Business",
  device_id: "BZG-INTERACTION-FIXTURE-0001",
  platform: "macos",
  architecture: "arm64",
  plan_name: "Offline ERP",
  issue_date: "2026-01-01",
  expiry_date: "2027-01-31",
  grace_days: 7,
  allowed_features: ["billing", "customers", "inventory", "orders", "products", "reports"],
  maximum_users: 1,
  maximum_businesses: 1,
  maximum_branches: 1,
  status: "active",
  effective_status: "active",
  issuer_key_id: "fixture-key",
  updated_at: "2026-08-26T18:42:46.819046+00:00",
}

export function LicenseActionFixture() {
  const suspendedFixtureRow = { ...fixtureRow, id: "LIC-INTERACTION-SUSPENDED-0002", status: "suspended", effective_status: "suspended" }
  const [activeAction, setActiveAction] = useState<{ action: AdminLicenseAction; row: Record<string, unknown> } | null>(null)
  const [lastControl, setLastControl] = useState("")
  const [lastMutation, setLastMutation] = useState<ValidUpdateLicenseInput | null>(null)

  async function confirm(input: ValidUpdateLicenseInput) {
    setLastMutation(input)
    setLastControl(input.action)
    setActiveAction(null)
  }

  return (
    <main className="min-h-dvh bg-black p-8 text-white">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.025] p-5">
        <h1 className="text-2xl font-black">Licence action interaction fixture</h1>
        <div className="mt-5 overflow-x-auto">
          <LicenseActionButtons
            row={fixtureRow}
            onAction={(action) => setActiveAction({ action, row: fixtureRow })}
            onCopy={() => setLastControl("copy")}
            onDownload={() => setLastControl("download")}
            onHistory={() => setLastControl("history")}
          />
        </div>
        <div className="mt-3 overflow-x-auto">
          <LicenseActionButtons
            row={suspendedFixtureRow}
            onAction={(action) => setActiveAction({ action, row: suspendedFixtureRow })}
            onCopy={() => setLastControl("copy-suspended")}
            onDownload={() => setLastControl("download-suspended")}
            onHistory={() => setLastControl("history-suspended")}
          />
        </div>
        <output data-last-license-control className="mt-5 block rounded-xl border border-white/10 p-3">{lastControl}</output>
        <pre data-last-license-mutation className="mt-3 whitespace-pre-wrap text-xs text-neutral-400">{lastMutation ? JSON.stringify(lastMutation) : ""}</pre>
      </section>
      {activeAction && (
        <LicenseActionDialog
          key={`${activeAction.row.id}:${activeAction.action}`}
          action={activeAction.action}
          row={activeAction.row}
          onClose={() => setActiveAction(null)}
          onConfirm={confirm}
        />
      )}
    </main>
  )
}
