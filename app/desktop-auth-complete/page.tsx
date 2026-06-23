import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"

export default function DesktopAuthCompletePage() {
  return (
    <main className="inventory-grid-bg flex min-h-dvh items-center justify-center px-4 py-8 text-white">
      <section className="w-full max-w-md rounded-[24px] border border-white/10 bg-neutral-950/90 p-6 text-center shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-8">
        <BezgrowLogoMark className="mx-auto h-14 w-14" size={56} priority />
        <h1 className="mt-5 text-2xl font-black">Google sign-in complete</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">
          You can return to the Bezgrow desktop app. It will continue automatically.
        </p>
      </section>
    </main>
  )
}
