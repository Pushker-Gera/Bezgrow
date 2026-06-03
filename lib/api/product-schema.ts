import { z } from "zod"

const nullableText = z
  .string()
  .trim()
  .max(255)
  .optional()
  .transform((value) => (value ? value : null))

const nullableNumber = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value) => {
    if (value === undefined || value === "") return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  })

export const productPayloadSchema = z.object({
  name: z.string().trim().min(1).max(180),
  description: z.string().trim().max(2000).optional().transform((value) => value || null),
  manufacturer: nullableText,
  sku: nullableText,
  barcode: nullableText,
  category: nullableText,
  unit: z.string().trim().max(40).optional().default("pcs"),
  supplier: nullableText,
  warehouse: z.string().trim().max(120).optional().default("Main Warehouse"),
  price: nullableNumber,
  stock: nullableNumber,
  min_stock: nullableNumber,
  batch_no: nullableText,
  mrp: nullableNumber,
  purchase_rate: nullableNumber,
  sale_rate: nullableNumber,
  gst: nullableNumber,
  expiry_date: nullableText,
  purchase_date: nullableText,
})

export const productUpdateSchema = productPayloadSchema.extend({
  id: z.string().uuid(),
})
