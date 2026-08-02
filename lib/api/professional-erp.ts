import "server-only"
import { localErpOnlyResponse } from "@/lib/api/local-erp-only"

/** @deprecated Professional ERP HTTP CRUD is disabled; packaged desktop uses SQLite directly. */
export async function handleProfessionalErpApi() {
  return localErpOnlyResponse()
}
