import "server-only"

const MESSAGE =
  "Customer ERP data is available only inside the Bezgrow desktop application and is stored in its local SQLite database."

export function localErpOnlyResponse() {
  return Response.json(
    {
      success: false,
      error: MESSAGE,
      code: "LOCAL_ERP_DESKTOP_ONLY",
      dataAuthority: "sqlite",
      synchronized: false,
    },
    {
      status: 410,
      headers: {
        "Cache-Control": "no-store",
        "X-Bezgrow-Data-Authority": "sqlite",
        "X-Bezgrow-Cloud-Erp": "disabled",
      },
    }
  )
}

export const localErpOnlyHandler = () => localErpOnlyResponse()
