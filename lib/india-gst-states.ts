export type IndiaGstState = {
  name: string
  code: string
}

export const INDIA_GST_STATES: readonly IndiaGstState[] = [
  { name: "Jammu and Kashmir", code: "01" },
  { name: "Himachal Pradesh", code: "02" },
  { name: "Punjab", code: "03" },
  { name: "Chandigarh", code: "04" },
  { name: "Uttarakhand", code: "05" },
  { name: "Haryana", code: "06" },
  { name: "Delhi", code: "07" },
  { name: "Rajasthan", code: "08" },
  { name: "Uttar Pradesh", code: "09" },
  { name: "Bihar", code: "10" },
  { name: "Sikkim", code: "11" },
  { name: "Arunachal Pradesh", code: "12" },
  { name: "Nagaland", code: "13" },
  { name: "Manipur", code: "14" },
  { name: "Mizoram", code: "15" },
  { name: "Tripura", code: "16" },
  { name: "Meghalaya", code: "17" },
  { name: "Assam", code: "18" },
  { name: "West Bengal", code: "19" },
  { name: "Jharkhand", code: "20" },
  { name: "Odisha", code: "21" },
  { name: "Chhattisgarh", code: "22" },
  { name: "Madhya Pradesh", code: "23" },
  { name: "Gujarat", code: "24" },
  { name: "Dadra and Nagar Haveli and Daman and Diu", code: "26" },
  { name: "Maharashtra", code: "27" },
  { name: "Andhra Pradesh", code: "37" },
  { name: "Karnataka", code: "29" },
  { name: "Goa", code: "30" },
  { name: "Lakshadweep", code: "31" },
  { name: "Kerala", code: "32" },
  { name: "Tamil Nadu", code: "33" },
  { name: "Puducherry", code: "34" },
  { name: "Andaman and Nicobar Islands", code: "35" },
  { name: "Telangana", code: "36" },
  { name: "Ladakh", code: "38" },
  { name: "Other Territory", code: "97" },
] as const

const stateByCode = new Map(INDIA_GST_STATES.map((state) => [state.code, state]))
const stateByName = new Map(INDIA_GST_STATES.map((state) => [state.name.toLocaleLowerCase("en-IN"), state]))

export function gstStateByCode(code: string | null | undefined) {
  const normalized = String(code || "").trim().padStart(2, "0")
  return /^\d{2}$/.test(normalized) ? stateByCode.get(normalized) || null : null
}

export function gstStateByName(name: string | null | undefined) {
  return stateByName.get(String(name || "").trim().toLocaleLowerCase("en-IN")) || null
}

export function gstStateFromGstin(gstin: string | null | undefined) {
  const code = String(gstin || "").trim().slice(0, 2)
  return /^\d{2}$/.test(code) ? gstStateByCode(code) : null
}

export function stateCodeForName(name: string | null | undefined) {
  return gstStateByName(name)?.code || ""
}

export function formatIndiaState(name: string | null | undefined, code: string | null | undefined) {
  const normalizedName = String(name || "").trim().replace(/^[-–—]$/, "")
  const normalizedCode = String(code || "").trim().replace(/^[-–—]$/, "")
  if (!normalizedName && !normalizedCode) return "-"
  if (normalizedName && normalizedCode) return `${normalizedName} (${normalizedCode})`
  return normalizedName || gstStateByCode(normalizedCode)?.name || normalizedCode || "-"
}
