import { ImageResponse } from "next/og"

export const alt = "Bezgrow cloud inventory management, GST billing, POS and ERP software"
export const size = {
  width: 1200,
  height: 630,
}
export const contentType = "image/png"

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#020403",
          color: "white",
          padding: "72px",
          fontFamily: "Arial, Helvetica, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "24px",
            marginBottom: "48px",
          }}
        >
          <div
            style={{
              width: "88px",
              height: "88px",
              borderRadius: "28px",
              background: "linear-gradient(135deg, #a5f3fc, #2563eb)",
              color: "#020403",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "46px",
              fontWeight: 900,
            }}
          >
            B
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: "54px", fontWeight: 900 }}>Bezgrow</div>
            <div style={{ fontSize: "22px", color: "#a5f3fc", letterSpacing: "0.18em" }}>BUSINESS CLOUD</div>
          </div>
        </div>
        <div style={{ maxWidth: "980px", fontSize: "76px", lineHeight: 1, fontWeight: 900 }}>
          Inventory Management, GST Billing & ERP Software
        </div>
        <div style={{ marginTop: "32px", maxWidth: "900px", fontSize: "30px", lineHeight: 1.35, color: "#cbd5e1" }}>
          Cloud software for retail, wholesale, POS, billing, invoices, analytics, and business management.
        </div>
      </div>
    ),
    size
  )
}
