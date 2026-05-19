"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"

import ShippingLabel from "@/components/ShippingLabel"

import { supabase } from "@/lib/supabase"

type OrderLabelRow = {
    customer_name: string | null
    customer_phone: string | null
    customer_address: string | null
    order_number: string | null
    tracking_number: string | null
    courier_name: string | null
    total_amount: number | null
}

export default function LabelPage() {

    const params = useParams()

    const orderId = params.id as string

    const [order, setOrder] = useState<OrderLabelRow | null>(null)

    const [loading, setLoading] = useState(true)

    const fetchOrder = useCallback(async () => {

        const { data, error } =
            await supabase
                .from("orders")
                .select("*")
                .eq("id", orderId)
                .single()

        if (error) {
            console.error(error)
        }

        setOrder(data as OrderLabelRow | null)

        setLoading(false)
    }, [orderId])

    useEffect(() => {
        if (orderId) {
            queueMicrotask(() => {
                void fetchOrder()
            })
        }
    }, [fetchOrder, orderId])

    if (loading) {

        return (

            <div className="min-h-screen bg-black text-white flex items-center justify-center">

                Loading shipping label...

            </div>

        )
    }

    if (!order) {

        return (

            <div className="min-h-screen bg-black text-white flex items-center justify-center">

                Order not found

            </div>

        )
    }

    return (

        <div className="min-h-screen bg-neutral-950 p-10 flex flex-col items-center gap-8">

            <ShippingLabel

                customerName={order.customer_name || "Customer"}

                customerPhone={order.customer_phone || "-"}

                customerAddress={order.customer_address || "-"}

                orderNumber={order.order_number || "ORDER"}

                trackingNumber={
                    order.tracking_number ||
                    "TRACKING-PENDING"
                }

                courierName={
                    order.courier_name ||
                    "ERP Courier"
                }

                codAmount={order.total_amount ?? undefined}

            />

            <button
                onClick={() => window.print()}
                className="px-6 py-4 rounded-2xl bg-white text-black font-semibold"
            >
                Print Label
            </button>

        </div>

    )
}
