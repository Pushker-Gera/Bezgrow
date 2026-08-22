"use client"

import type { FormEvent } from "react"
import { useMemo, useState } from "react"
import {
  AdminListControls,
  AdminModal,
  AdminNotice,
  AdminPageHeader,
  AdminPagination,
  AdminTable,
  StatusPill,
  adminMutation,
  displayValue,
  formatAdminDate,
  useAdminList,
} from "@/components/admin/ControlPlaneUi"

const initialRelease = {
  version: "",
  build_number: "",
  platform: "macos",
  architecture: "arm64",
  release_channel: "manual",
  publication_mode: "cross-platform",
  build_commit: "",
  build_timestamp: "",
  artifact_type: "dmg",
  file_url: "",
  file_size: "",
  sha256: "",
  updater_url: "",
  updater_size: "",
  updater_sha256: "",
  update_signature: "",
  mandatory_after: "",
  minimum_supported_version: "",
  release_notes: "",
  rollout_percentage: "100",
}

export default function ReleasesPage() {
  const [platform, setPlatform] = useState("")
  const [status, setStatus] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState(initialRelease)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const filters = useMemo(() => ({ platform, status }), [platform, status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/releases", filters)
  const exportParams = new URLSearchParams({ format: "csv", search: list.search, platform, status })

  async function createRelease(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setActionError("")
    try {
      await adminMutation("/api/admin/releases", "POST", {
        ...form,
        file_size: form.file_size ? Number(form.file_size) : undefined,
        sha256: form.sha256 || undefined,
        updater_size: form.updater_size ? Number(form.updater_size) : undefined,
        updater_sha256: form.updater_sha256 || undefined,
        updater_url: form.updater_url || undefined,
        update_signature: form.update_signature || undefined,
        build_timestamp: new Date(form.build_timestamp).toISOString(),
        mandatory_after: form.mandatory_after ? new Date(form.mandatory_after).toISOString() : undefined,
        rollout_percentage: Number(form.rollout_percentage),
        mandatory: false,
      })
      setCreateOpen(false)
      setForm(initialRelease)
      setNotice("Draft release created. Verify its artifact before publishing.")
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Release draft failed.")
    } finally {
      setSaving(false)
    }
  }

  async function runAction(row: Record<string, unknown>, action: string) {
    setNotice("")
    setActionError("")
    const body: Record<string, unknown> = { id: row.id, action }
    if (action === "set_rollout") {
      const value = window.prompt("Rollout percentage (0-100)", String(row.rollout_percentage || 100))
      if (value === null) return
      body.rollout_percentage = Number(value)
    }
    if (action === "mark_mandatory") body.mandatory = !row.mandatory
    try {
      await adminMutation("/api/admin/releases", "PATCH", body)
      setNotice(
        action === "verify_artifact"
          ? "Artifact verification completed; valid candidates are now READY."
          : action === "publish"
            ? "The complete validated release cohort was published atomically."
            : "Release status updated and audited."
      )
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Release action failed.")
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Desktop distribution"
        title="Releases and updates"
        description="Register and validate each platform independently. Manual installation releases require real integrity-verified artifacts; stable publication additionally requires a Minisign-verified Tauri updater artifact, code signing, and macOS notarization."
        action={<button type="button" onClick={() => setCreateOpen(true)} className="h-12 rounded-2xl bg-cyan-300 px-5 text-sm font-black text-black">Create draft release</button>}
      />
      <AdminNotice tone="warning">
        Integrity validation is always required. Valid unsigned or unnotarized builds may publish explicitly as manual installation releases; stable production releases still require platform trust and updater signature checks.
      </AdminNotice>
      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        exportHref={`/api/admin/releases?${exportParams}`}
        filters={
          <>
            <select value={platform} onChange={(event) => setPlatform(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
              <option value="">All platforms</option>
              <option value="macos">macOS</option>
              <option value="windows">Windows</option>
            </select>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
              <option value="">All statuses</option>
              {["draft", "building", "validating", "ready", "published", "failed", "paused", "retired"].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </>
        }
      />
      <AdminTable
        loading={list.loading}
        error={list.error}
        empty="No desktop release metadata has been created."
        rows={list.data}
        columns={[
          {
            key: "version",
            label: "Release",
            render: (row) => <div><p className="font-black text-white">v{displayValue(row.version)} ({displayValue(row.build_number)})</p><p className="mt-1 text-xs text-neutral-500">{displayValue(row.platform)} · {displayValue(row.architecture)} · {["manual", "internal"].includes(String(row.release_channel)) ? "manual installation" : displayValue(row.release_channel)}</p><p className="mt-1 text-xs text-neutral-600">{displayValue(row.publication_mode, "cross-platform")} · Minimum: {displayValue(row.minimum_supported_version, "Not configured")}</p><code className="mt-1 block max-w-[220px] truncate text-[10px] text-neutral-600">{displayValue(row.build_commit, "Commit not recorded")}</code></div>,
          },
          {
            key: "artifact",
            label: "Artifact",
            render: (row) => {
              const artifact = (Array.isArray(row.release_artifacts) ? row.release_artifacts[0] : null) as Record<string, unknown> | null
              return artifact ? <div><p className="max-w-[260px] truncate text-xs text-cyan-100">{displayValue(artifact.file_url)}</p><p className="mt-1 text-xs text-neutral-500">{artifact.file_size ? `${Number(artifact.file_size).toLocaleString()} bytes` : "File size not reported"}</p><code className="mt-1 block max-w-[260px] truncate text-[10px] text-neutral-600">{displayValue(artifact.sha256, "SHA-256 not configured")}</code></div> : <span className="text-red-200">Release artifact unavailable</span>
            },
          },
          {
            key: "validation",
            label: "Validation",
            render: (row) => {
              const artifact = (Array.isArray(row.release_artifacts) ? row.release_artifacts[0] : null) as Record<string, unknown> | null
              return artifact ? <div className="space-y-1.5"><StatusPill value={`artifact ${artifact.validation_status}`} /><br /><StatusPill value={`updater ${artifact.updater_signature_status || "pending"}`} /><br /><StatusPill value={`signature ${artifact.signature_status}`} /><br /><StatusPill value={`code signing ${artifact.code_signing_status}`} />{row.platform === "macos" && <><br /><StatusPill value={`notarization ${artifact.notarization_status}`} /></>}</div> : <StatusPill value="missing artifact" />
            },
          },
          {
            key: "rollout",
            label: "Rollout",
            render: (row) => <div><p>{displayValue(row.rollout_percentage)}%</p><p className="mt-1 text-xs text-neutral-500">{row.mandatory ? "Mandatory update" : "Optional update"}</p><p className="mt-1 text-xs text-neutral-500">7d checks: {Number(row.update_checks_7d || 0).toLocaleString()} · available: {Number(row.update_available_7d || 0).toLocaleString()}</p><p className={`mt-1 text-xs ${Number(row.update_failures_7d || 0) > 0 ? "text-red-200" : "text-neutral-500"}`}>Update failures: {Number(row.update_failures_7d || 0).toLocaleString()}</p><p className="mt-1 text-xs text-neutral-600">{row.published_at ? formatAdminDate(row.published_at) : "Not published"}</p></div>,
          },
          { key: "release_status", label: "Status", render: (row) => <StatusPill value={row.release_status} /> },
          {
            key: "actions",
            label: "Actions",
            render: (row) => {
              const artifact = (Array.isArray(row.release_artifacts) ? row.release_artifacts[0] : null) as Record<string, unknown> | null
              return (
                <div className="flex min-w-[250px] flex-wrap gap-2">
                  {Boolean(artifact?.file_url) && <button type="button" onClick={() => void navigator.clipboard.writeText(String(artifact?.file_url))} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Copy URL</button>}
                  <button type="button" disabled={!artifact} onClick={() => void runAction(row, "verify_artifact")} className="rounded-lg border border-cyan-400/25 px-2.5 py-1.5 text-xs font-bold text-cyan-100 disabled:opacity-30">Verify artifact</button>
                  {row.release_status === "ready" && <button type="button" onClick={() => void runAction(row, "publish")} className="rounded-lg border border-emerald-400/25 px-2.5 py-1.5 text-xs font-bold text-emerald-100">Publish release</button>}
                  {row.release_status === "published" && <button type="button" onClick={() => void runAction(row, "unpublish")} className="rounded-lg border border-amber-400/25 px-2.5 py-1.5 text-xs font-bold text-amber-100">Unpublish</button>}
                  {row.release_status === "paused" && <button type="button" onClick={() => void runAction(row, "resume")} className="rounded-lg border border-emerald-400/25 px-2.5 py-1.5 text-xs font-bold text-emerald-100">Resume</button>}
                  {!["manual", "internal"].includes(String(row.release_channel)) && <button type="button" onClick={() => void runAction(row, "mark_manual")} className="rounded-lg border border-amber-400/25 px-2.5 py-1.5 text-xs font-bold text-amber-100">Mark manual installation</button>}
                  {["manual", "internal"].includes(String(row.release_channel)) && <button type="button" onClick={() => void runAction(row, "mark_stable")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Mark stable</button>}
                  <button type="button" onClick={() => void runAction(row, "set_rollout")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Rollout %</button>
                  <button type="button" onClick={() => void runAction(row, "mark_mandatory")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">{row.mandatory ? "Make optional" : "Mark mandatory"}</button>
                  {row.release_status !== "retired" && <button type="button" onClick={() => void runAction(row, "archive")} className="rounded-lg border border-red-400/20 px-2.5 py-1.5 text-xs font-bold text-red-200">Archive</button>}
                </div>
              )
            },
          },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />

      <AdminModal open={createOpen} title="Create draft release" onClose={() => setCreateOpen(false)}>
        <form onSubmit={createRelease} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["version", "Version", "text"],
              ["build_number", "Build number", "text"],
              ["build_commit", "Exact 40-character build commit", "text"],
              ["build_timestamp", "Build timestamp", "datetime-local"],
              ["file_url", "HTTPS artifact URL", "url"],
              ["file_size", "File size in bytes (optional)", "number"],
              ["sha256", "SHA-256 (optional)", "text"],
              ["updater_url", "HTTPS updater artifact URL", "url"],
              ["updater_size", "Updater size in bytes", "number"],
              ["updater_sha256", "Updater SHA-256", "text"],
              ["minimum_supported_version", "Minimum supported version", "text"],
              ["mandatory_after", "Mandatory after (optional)", "datetime-local"],
              ["rollout_percentage", "Rollout percentage", "number"],
            ].map(([key, label, type]) => (
              <label key={key} className={`${["file_url", "sha256", "updater_url", "updater_sha256"].includes(key) ? "sm:col-span-2" : ""} text-sm font-bold text-neutral-300`}>
                {label}
                <input type={type} required={["version", "build_number", "build_commit", "build_timestamp", "file_url"].includes(key)} value={form[key as keyof typeof form]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/50 px-3 outline-none focus:border-cyan-400/40" />
              </label>
            ))}
            {[
              ["platform", "Platform", ["macos", "windows"]],
              ["architecture", "Architecture", ["arm64", "x64"]],
              ["release_channel", "Channel", ["stable", "beta", "manual", "internal"]],
              ["publication_mode", "Publication policy", ["cross-platform", "staged"]],
            ].map(([key, label, options]) => (
              <label key={String(key)} className="text-sm font-bold text-neutral-300">
                {String(label)}
                <select
                  value={form[key as keyof typeof form]}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      [String(key)]: event.target.value,
                      ...(key === "platform"
                        ? { artifact_type: event.target.value === "macos" ? "dmg" : "nsis" }
                        : {}),
                    }))
                  }
                  className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black px-3"
                >
                  {(options as string[]).map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
                </select>
              </label>
            ))}
            <label className="text-sm font-bold text-neutral-300">
              Installer type
              <select
                value={form.artifact_type}
                onChange={(event) => setForm((current) => ({ ...current, artifact_type: event.target.value }))}
                className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black px-3"
              >
                {(form.platform === "macos" ? ["dmg"] : ["nsis", "msi", "msix"]).map((option) => (
                  <option key={option} value={option}>{option.toUpperCase()}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs leading-5 text-neutral-500">
            “Verify artifact” downloads both registered artifacts, rejects broken installer responses, verifies exact SHA-256 values, and cryptographically verifies the updater signature using the server-side public key. Private signing keys are never accepted here.
          </p>
          <label className="block text-sm font-bold text-neutral-300">
            Tauri updater signature
            <textarea value={form.update_signature} onChange={(event) => setForm((current) => ({ ...current, update_signature: event.target.value }))} className="mt-2 min-h-24 w-full rounded-xl border border-white/10 bg-black/50 p-3 font-mono text-xs outline-none focus:border-cyan-400/40" placeholder="Base64 content from the generated .sig artifact" />
          </label>
          <label className="block text-sm font-bold text-neutral-300">
            Release notes
            <textarea value={form.release_notes} onChange={(event) => setForm((current) => ({ ...current, release_notes: event.target.value }))} className="mt-2 min-h-28 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-cyan-400/40" />
          </label>
          {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
          <button type="submit" disabled={saving} className="h-12 w-full rounded-2xl bg-cyan-300 text-sm font-black text-black disabled:opacity-40">
            {saving ? "Creating draft…" : "Create draft release"}
          </button>
        </form>
      </AdminModal>
    </div>
  )
}
