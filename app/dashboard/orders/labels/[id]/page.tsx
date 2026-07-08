"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"

import ShippingLabel from "@/components/ShippingLabel"

import { getCachedWorkspaceBootstrap, getOfflineData } from "@/lib/offline/db"
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
        const cachedWorkspace = getCachedWorkspaceBootstrap()
        const organizationId = cachedWorkspace?.organization?.id || cachedWorkspace?.membership?.organization_id || ""
        if (organizationId) {
            const cachedOrders = await getOfflineData<Array<OrderLabelRow & { id?: string }>>(organizationId, "orders", [])
            const cachedOrder = cachedOrders.find((row) => row.id === orderId)
            if (cachedOrder) {
                setOrder(cachedOrder)
                setLoading(false)
                return
            }
        }

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

            <div className="flex min-h-dvh items-center justify-center bg-black text-white">

                Loading shipping label...

            </div>

        )
    }

    if (!order) {

        return (

            <div className="flex min-h-dvh items-center justify-center bg-black text-white">

                Order not found

            </div>

        )
    }

    return (

        <div className="flex min-h-dvh flex-col items-center gap-5 bg-neutral-950 p-4 sm:gap-8 sm:p-10">

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
                    "Courier"
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
