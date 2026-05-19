"use client"

import { useEffect } from "react"
import { useParams, useRouter } from "next/navigation"

export default function InvoiceViewPage() {
  const params = useParams()
  const router = useRouter()
  const invoiceId = Array.isArray(params.id) ? params.id[0] : params.id

  useEffect(() => {
    if (invoiceId) router.replace(`/dashboard/invoices/${invoiceId}/print`)
  }, [invoiceId, router])

  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-white">
      <div className="text-center">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-neutral-800 border-t-cyan-300" />
        <p className="mt-5 text-lg font-semibold">Opening exact invoice bill...</p>
      </div>
    </div>
  )
}
