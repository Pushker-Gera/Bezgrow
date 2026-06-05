import Link from "next/link"

type FeaturePageProps = {
  eyebrow: string
  title: string
  description: string
  highlights: string[]
  workflows: string[]
  metrics: Array<[string, string]>
}

export function FeaturePage({ eyebrow, title, description, highlights, workflows, metrics }: FeaturePageProps) {
  return (
    <main className="min-h-dvh overflow-hidden bg-[#020403] text-white">
      <div className="inventory-grid-bg fixed inset-0 opacity-50" />
      <div className="relative z-10">
        <nav className="mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-4 py-5 lg:px-8" aria-label="Primary navigation">
          <Link href="/" className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-200 to-blue-400 text-lg font-black text-black">B</span>
            <span>
              <span className="block text-lg font-black">Bezgrow</span>
              <span className="block text-xs uppercase tracking-[0.18em] text-white/45">Business Cloud</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3 text-sm font-bold text-white/75 hover:border-cyan-300/40">
              Login
            </Link>
            <Link href="/signup" className="rounded-2xl bg-white px-5 py-3 text-sm font-black text-black hover:bg-cyan-100">
              Start
            </Link>
          </div>
        </nav>

        <section className="mx-auto grid min-h-[calc(100dvh-88px)] w-full max-w-7xl items-center gap-10 px-4 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:px-8">
          <div>
            <p className="inline-flex rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs font-black uppercase tracking-[0.22em] text-cyan-100">
              {eyebrow}
            </p>
            <h1 className="mt-6 text-4xl font-black leading-[0.98] sm:text-6xl lg:text-7xl">{title}</h1>
            <p className="mt-6 max-w-3xl text-lg leading-8 text-white/62">{description}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/signup" className="rounded-2xl bg-cyan-300 px-7 py-4 text-center font-black text-black shadow-[0_0_44px_rgba(34,211,238,0.25)] hover:bg-cyan-200">
                Create Workspace
              </Link>
              <Link href="/" className="rounded-2xl border border-white/12 bg-white/[0.04] px-7 py-4 text-center font-bold text-white/85 hover:border-white/30">
                Back to Home
              </Link>
            </div>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-white/[0.045] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.35)] backdrop-blur-xl">
            <div className="grid gap-3 sm:grid-cols-3">
              {metrics.map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-white/10 bg-black/35 p-4">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-100/70">{label}</p>
                  <p className="mt-3 text-2xl font-black text-white">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.06] p-5">
              <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-100">Core capabilities</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {highlights.map((item) => (
                  <div key={item} className="rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm font-bold text-white/80">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 pb-16 lg:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            {workflows.map((workflow, index) => (
              <article key={workflow} className="rounded-[24px] border border-white/10 bg-white/[0.035] p-6">
                <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300/12 text-sm font-black text-cyan-100">
                  0{index + 1}
                </div>
                <h2 className="text-2xl font-black">{workflow}</h2>
                <p className="mt-3 leading-7 text-white/52">
                  Designed for fast teams that need dependable daily operations, clean records, and professional output from day one.
                </p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}
