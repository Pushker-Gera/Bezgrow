"use client"

import { useEffect, useState } from "react"
import { usePathname } from "next/navigation"

const keys = ["INV", "GST", "POS", "ERP", "7", "8", "9", "+", "4", "5", "6", "-", "1", "2", "3", "=", "0", "00", ".", "Rs"]

export default function EntryCalculatorAnimation() {
  const [show, setShow] = useState(false)
  const pathname = usePathname()

  useEffect(() => {
    if (pathname !== "/") {
      return
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    if (reducedMotion) return

    const frame = window.requestAnimationFrame(() => setShow(true))

    const timer = window.setTimeout(() => setShow(false), 2100)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [pathname])

  if (!show) return null

  return (
    <div className="entry-calculator-overlay" aria-hidden="true">
      <div className="entry-calculator-glow" />
      <div className="entry-calculator-scene">
        <div className="entry-calculator">
          <div className="entry-calculator-depth" />
          <div className="entry-calculator-screen">
            <span>BEZGROW</span>
            <strong>Rs 1,24,900</strong>
            <small>Inventory + GST Billing + POS</small>
          </div>
          <div className="entry-calculator-tape">
            <span>INV-2026</span>
            <span>GST READY</span>
          </div>
          <div className="entry-calculator-keys">
            {keys.map((key) => (
              <span key={key}>{key}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
