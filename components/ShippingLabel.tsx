"use client"

import { QRCodeCanvas } from "qrcode.react"
import Barcode from "react-barcode"

interface ShippingLabelProps {

    customerName: string
    customerPhone: string
    customerAddress: string

    orderNumber: string

    trackingNumber: string

    courierName?: string

    codAmount?: number
}

export default function ShippingLabel({

    customerName,
    customerPhone,
    customerAddress,

    orderNumber,

    trackingNumber,

    courierName,

    codAmount,

}: ShippingLabelProps) {

    return (

        <div className="w-[400px] bg-white text-black rounded-xl border border-black p-6 space-y-4">

            <div className="flex items-center justify-between">

                <div>

                    <p className="text-xs uppercase tracking-wide text-gray-500">
                        Shipping Label
                    </p>

                    <h2 className="text-2xl font-bold">
                        {courierName || "ERP Courier"}
                    </h2>

                </div>

                <QRCodeCanvas
                    value={trackingNumber}
                    size={72}
                />

            </div>

            <div className="border-t border-dashed border-black pt-4">

                <p className="text-xs text-gray-500 uppercase">
                    Customer
                </p>

                <p className="font-bold text-lg mt-1">
                    {customerName}
                </p>

                <p className="text-sm mt-1">
                    {customerPhone}
                </p>

                <p className="text-sm whitespace-pre-line mt-2">
                    {customerAddress}
                </p>

            </div>

            <div className="border-t border-dashed border-black pt-4 space-y-2">

                <div className="flex items-center justify-between">

                    <span className="text-sm text-gray-500">
                        Order Number
                    </span>

                    <span className="font-semibold">
                        {orderNumber}
                    </span>

                </div>

                <div className="flex items-center justify-between">

                    <span className="text-sm text-gray-500">
                        Tracking Number
                    </span>

                    <span className="font-semibold">
                        {trackingNumber}
                    </span>

                </div>

                {codAmount && (

                    <div className="flex items-center justify-between">

                        <span className="text-sm text-gray-500">
                            COD Amount
                        </span>

                        <span className="font-bold">
                            ₹{codAmount}
                        </span>

                    </div>

                )}

            </div>

            <div className="border-t border-dashed border-black pt-4 flex justify-center">

                <Barcode
                    value={trackingNumber}
                    height={50}
                    width={1.5}
                    fontSize={14}
                />

            </div>

        </div>

    )
}