import { existsSync } from "node:fs"
import { join } from "node:path"
import Link from "next/link"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import packageJson from "@/package.json"

const macInstallerPath = "/downloads/Bezgrow-mac.dmg"
const windowsInstallerPath = "/downloads/Bezgrow-windows.exe"

export const metadata: Metadata = {
  title: "Download Bezgrow Desktop App",
  description: "Download the Bezgrow desktop ERP app for Mac and Windows.",
  alternates: {
    canonical: "https://www.bezgrow.com/download",
  },
}

function installerExists(path: string) {
  return existsSync(join(process.cwd(), "public", path.replace(/^\/+/, "")))
}

function DownloadButton({
  href,
  available,
  children,
}: {
  href: string
  available: boolean
  children: ReactNode
}) {
  const className =
    "flex min-h-12 items-center justify-center rounded-2xl px-5 text-sm font-black transition sm:min-h-14 sm:px-7"

  if (!available) {
    return (
      <span className={`${className} cursor-not-allowed border border-white/10 bg-white/[0.04] text-white/35`}>
        {children}
      </span>
    )
  }

  return (
    <a href={href} className={`${className} bg-cyan-300 text-black shadow-[0_0_44px_rgba(34,211,238,0.22)] hover:bg-cyan-200`}>
      {children}
    </a>
  )
}

export default function DownloadPage() {
  const macAvailable = installerExists(macInstallerPath)
  const windowsAvailable = installerExists(windowsInstallerPath)
  const installersReady = macAvailable || windowsAvailable

  return (
    <main className="min-h-dvh bg-[#020403] px-5 py-8 text-white sm:py-10 lg:px-8">
      <section className="mx-auto flex min-h-[calc(100dvh-80px)] max-w-5xl flex-col justify-center">
        <Link href="/" className="mb-10 inline-flex w-fit items-center gap-3 text-sm font-black text-cyan-100 hover:text-white">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-200 to-blue-400 text-lg text-black">B</span>
          Bezgrow
        </Link>

        <div className="rounded-[28px] border border-white/10 bg-white/[0.035] p-6 shadow-[0_24px_90px_rgba(0,0,0,0.35)] sm:p-8 lg:p-10">
          <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan-200">Desktop ERP</p>
          <h1 className="mt-4 text-4xl font-black tracking-tight sm:text-5xl">Bezgrow Desktop App</h1>
          <p className="mt-4 max-w-2xl leading-8 text-white/62">
            Install Bezgrow on your computer for desktop ERP workflows, persistent login, local offline data, printing, and sync when internet returns.
          </p>

          <div className="mt-6 inline-flex rounded-full border border-white/10 bg-black/35 px-4 py-2 text-sm font-bold text-white/65">
            Version {packageJson.version}
          </div>

          {!installersReady && (
            <div className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100">
              Desktop installers are being prepared. Please contact support.
            </div>
          )}

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <DownloadButton href={macInstallerPath} available={macAvailable}>
              Download for Mac
            </DownloadButton>
            <DownloadButton href={windowsInstallerPath} available={windowsAvailable}>
              Download for Windows
            </DownloadButton>
          </div>

          <div className="mt-8 grid gap-4 text-sm leading-7 text-white/58 md:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <h2 className="text-base font-black text-white">1. Download</h2>
              <p className="mt-2">Choose the installer for your operating system.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <h2 className="text-base font-black text-white">2. Install</h2>
              <p className="mt-2">Open the installer and follow your system prompts.</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4">
              <h2 className="text-base font-black text-white">3. Sign In</h2>
              <p className="mt-2">Log in once online, then Bezgrow can reopen with local offline data.</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
