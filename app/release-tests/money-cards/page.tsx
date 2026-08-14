import { notFound } from "next/navigation"
import { MoneyValue } from "@/components/MoneyValue"

const representativeValues = [
  999,
  9_999,
  99_999,
  9_99_999,
  1_23_45_678,
  9_99_99_99_999,
  1_00_00_00_00_00_000,
  Number.MAX_SAFE_INTEGER,
]

export const dynamic = "force-dynamic"

export default function MoneyCardReleaseFixture() {
  if (process.env.BEZGROW_RELEASE_TEST !== "1") notFound()

  return (
    <main data-release-money-fixture className="mx-auto min-h-dvh w-full max-w-[1360px] bg-black p-6 text-white">
      <section className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        {representativeValues.map((value) => (
          <article
            key={value}
            data-money-card
            className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-zinc-950 p-5"
          >
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-neutral-500">Inventory Value</p>
            <div className="mt-4 min-w-0 font-black text-emerald-200">
              <MoneyValue value={value} className="font-black" />
            </div>
            <p className="mt-3 text-xs text-neutral-500">Exact value remains available</p>
          </article>
        ))}
      </section>
    </main>
  )
}
