import "server-only"

export function legacyApprovalDisabled() {
  return Response.json(
    {
      success: false,
      error: "Legacy account approval is disabled. Customer access is controlled by an offline-verifiable device license.",
      code: "LEGACY_APPROVAL_REMOVED",
    },
    {
      status: 410,
      headers: { "Cache-Control": "no-store" },
    }
  )
}
