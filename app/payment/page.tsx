"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

type BillingPlan = "monthly" | "yearly"

const plans: Record<BillingPlan, { label: string; price: number; cycle: string; note: string; badge: string }> = {
  monthly: { label: "Monthly", price: 250, cycle: "/ month", note: "Flexible access for new teams.", badge: "Start small" },
  yearly: { label: "Yearly", price: 2000, cycle: "/ year", note: "Save more for serious launch.", badge: "Best value" },
}

const steps = ["Choose plan", "Scan QR", "Enter UPI reference", "Activate"]

export default function PaymentPage() {
  const router = useRouter()
  const [plan, setPlan] = useState<BillingPlan>("monthly")
  const [reference, setReference] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const selectedPlan = useMemo(() => plans[plan], [plan])

  useEffect(() => {
    async function checkSession() {
      const { data } = await supabase.auth.getSession()
      if (!data.session) router.replace("/login")
    }

    void checkSession()
  }, [router])

  async function activateAfterPayment() {
    setLoading(true)
    setMessage("")

    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    if (!token) {
      router.push("/login")
      return
    }

    const response = await fetch("/api/payment/activate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ plan, reference }),
    })

    const result = await response.json()
    if (!response.ok || !result.success) {
      setMessage(result.error || "Payment activation failed.")
      setLoading(false)
      return
    }

    setMessage("Payment recorded. Opening your business setup...")
    router.push(result.redirectTo || "/create-business")
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#030504] px-4 py-5 text-white sm:px-6 lg:px-8">
      <div className="inventory-grid-bg fixed inset-0 opacity-55" />
      <div className="relative mx-auto flex min-h-[calc(100vh-40px)] max-w-6xl flex-col justify-center">
        <nav className="mb-5 flex items-center justify-between">
          <Link href="/" className="rounded-2xl border border-white/10 bg-black/50 px-4 py-3">
            <span className="block text-xs font-black uppercase tracking-[0.24em] text-cyan-200">Bezgrow</span>
            <span className="text-sm font-bold text-white/70">Subscription checkout</span>
          </Link>
          <Link href="/pending-approval" className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-bold text-white/75">
            Admin approval
          </Link>
        </nav>

        <section className="payment-card-rise overflow-hidden rounded-[28px] border border-white/10 bg-[#070a0a]/95 shadow-[0_30px_110px_rgba(0,0,0,0.55)] backdrop-blur-xl">
          <div className="grid gap-0 lg:grid-cols-[1.05fr,390px]">
            <div className="p-5 sm:p-7 lg:p-8">
              <p className="text-xs font-black uppercase tracking-[0.28em] text-cyan-200">UPI activation</p>
              <h1 className="mt-4 max-w-3xl text-3xl font-black leading-tight sm:text-4xl lg:text-5xl">
                Activate Bezgrow ERP in minutes.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-white/58">
                Pick a plan, pay through the QR, enter the UPI reference, and continue to business setup. Manual admin approval stays available.
              </p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {(Object.keys(plans) as BillingPlan[]).map((value) => (
                  <button
                    key={value}
                    onClick={() => setPlan(value)}
                    className={`group rounded-2xl border p-4 text-left transition-all duration-300 ${plan === value ? "border-cyan-300 bg-cyan-300/12 shadow-[0_0_36px_rgba(34,211,238,0.14)]" : "border-white/10 bg-black/35 hover:-translate-y-1 hover:border-white/25"}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-black">{plans[value].label}</p>
                      <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold text-white/60">{plans[value].badge}</span>
                    </div>
                    <p className="mt-4 text-3xl font-black">Rs {plans[value].price}<span className="text-sm font-bold text-white/45"> {plans[value].cycle}</span></p>
                    <p className="mt-2 text-sm text-white/50">{plans[value].note}</p>
                  </button>
                ))}
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-4">
                {steps.map((step, index) => (
                  <div key={step} className="rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                    <p className="text-xs font-black text-cyan-200">0{index + 1}</p>
                    <p className="mt-1 text-sm font-bold text-white/70">{step}</p>
                  </div>
                ))}
              </div>

              <div className="mt-6 rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100">
                For public launch, connect a payment gateway webhook for automatic bank-verified approval. This QR checkout records user confirmation.
              </div>
            </div>

            <aside className="border-t border-white/10 bg-black/35 p-5 sm:p-7 lg:border-l lg:border-t-0">
              <div className="mx-auto max-w-[300px] rounded-[26px] border border-white/10 bg-white p-3 shadow-[0_18px_70px_rgba(34,211,238,0.16)]">
                <Image
                  src="/subscription-upi-qr.jpeg"
                  alt="UPI payment QR code"
                  width={520}
                  height={520}
                  priority
                  className="aspect-square w-full rounded-2xl object-contain"
                />
              </div>

              <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Pay now</p>
                    <p className="mt-2 text-4xl font-black">Rs {selectedPlan.price}</p>
                  </div>
                  <p className="rounded-full bg-cyan-300/12 px-3 py-1 text-xs font-bold text-cyan-100">{selectedPlan.label}</p>
                </div>
              </div>

              <label className="mt-4 block text-xs font-bold uppercase tracking-[0.18em] text-white/45">
                UPI reference
              </label>
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="Transaction ID"
                className="mt-2 h-12 w-full rounded-2xl border border-white/10 bg-black px-4 font-semibold outline-none transition focus:border-cyan-300"
              />

              {message && (
                <div className="mt-4 rounded-2xl border border-cyan-300/30 bg-cyan-300/10 p-3 text-sm text-cyan-100">
                  {message}
                </div>
              )}

              <button
                onClick={activateAfterPayment}
                disabled={loading}
                className="mt-4 h-12 w-full rounded-2xl bg-cyan-300 font-black text-black transition hover:bg-cyan-200 disabled:opacity-60"
              >
                {loading ? "Activating..." : "Activate Account"}
              </button>
              <Link href="/pending-approval" className="mt-3 flex h-12 items-center justify-center rounded-2xl border border-white/10 font-bold text-white/75">
                Request Admin Approval
              </Link>
            </aside>
          </div>
        </section>
      </div>
    </main>
  )
}
