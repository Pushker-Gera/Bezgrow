import "server-only"
import { z } from "zod"
import { localErpOnlyResponse } from "@/lib/api/local-erp-only"

export type WorkspaceContext = never

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  search: z.string().default(""),
  sort: z.string().default("created_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
})

export type PaginationParams = z.infer<typeof paginationSchema>

export function parsePagination(request: Request) {
  const url = new URL(request.url)
  return paginationSchema.parse(Object.fromEntries(url.searchParams))
}

export function paginationRange(input: PaginationParams) {
  const from = (input.page - 1) * input.limit
  return { from, to: from + input.limit - 1 }
}

/** @deprecated Browser/server ERP workspaces no longer have a cloud tenant. */
export async function requireWorkspace() {
  return { ok: false as const, response: localErpOnlyResponse() }
}
