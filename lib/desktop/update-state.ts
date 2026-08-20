export const UPDATE_DECISION_KEY = "bezgrow.desktop-update-decision.v1"
export const UPDATE_INSTALL_EVENT = "bezgrow:install-update"
export const UPDATE_CHECK_EVENT = "bezgrow:check-update"
export const UPDATE_PENDING_RESTART_KEY = "bezgrow.desktop-update-pending-restart.v1"

export const SAFE_AUTO_UPDATE_DELAY_MS = 48 * 60 * 60 * 1000
export const REMIND_LATER_DELAY_MS = 6 * 60 * 60 * 1000

export type UpdateDecision = {
  version: string
  firstSeenAt: number
  nextPromptAt: number
  scheduledFor: number | null
  lastAttemptAt: number | null
}

export type PendingUpdateRestart = {
  expectedVersion: string
  installedFromVersion: string
  installedAt: number
}

function versionAtLeast(currentVersion: string, expectedVersion: string) {
  const parts = (value: string) => value.replace(/^v/i, "").split(/[+-]/, 1)[0].split(".").map((part) => Number(part) || 0)
  const current = parts(currentVersion)
  const expected = parts(expectedVersion)
  for (let index = 0; index < 3; index += 1) {
    if ((current[index] || 0) > (expected[index] || 0)) return true
    if ((current[index] || 0) < (expected[index] || 0)) return false
  }
  return true
}

export function markUpdatePendingRestart(expectedVersion: string, installedFromVersion: string, installedAt = Date.now()) {
  const pending = { expectedVersion, installedFromVersion, installedAt } satisfies PendingUpdateRestart
  localStorage.setItem(UPDATE_PENDING_RESTART_KEY, JSON.stringify(pending))
  return pending
}

export function readPendingUpdateRestart() {
  try {
    const pending = JSON.parse(localStorage.getItem(UPDATE_PENDING_RESTART_KEY) || "null") as Partial<PendingUpdateRestart> | null
    if (pending?.expectedVersion && pending.installedFromVersion && Number.isFinite(pending.installedAt)) {
      return pending as PendingUpdateRestart
    }
  } catch {
    // Invalid state is cleared below so it cannot produce a false success.
  }
  localStorage.removeItem(UPDATE_PENDING_RESTART_KEY)
  return null
}

export function pendingUpdateHasLaunched(pending: PendingUpdateRestart, currentVersion: string) {
  return versionAtLeast(currentVersion, pending.expectedVersion)
}

export function clearPendingUpdateRestart() {
  localStorage.removeItem(UPDATE_PENDING_RESTART_KEY)
}

export function readUpdateDecision(version: string, now = Date.now()): UpdateDecision {
  try {
    const parsed = JSON.parse(localStorage.getItem(UPDATE_DECISION_KEY) || "null") as Partial<UpdateDecision> | null
    if (parsed?.version === version && Number.isFinite(parsed.firstSeenAt)) {
      return {
        version,
        firstSeenAt: Number(parsed.firstSeenAt),
        nextPromptAt: Number.isFinite(parsed.nextPromptAt) ? Number(parsed.nextPromptAt) : now,
        scheduledFor: Number.isFinite(parsed.scheduledFor) ? Number(parsed.scheduledFor) : null,
        lastAttemptAt: Number.isFinite(parsed.lastAttemptAt) ? Number(parsed.lastAttemptAt) : null,
      }
    }
  } catch {
    // A damaged preference must not suppress a genuine update notification.
  }
  return { version, firstSeenAt: now, nextPromptAt: now, scheduledFor: null, lastAttemptAt: null }
}

export function writeUpdateDecision(decision: UpdateDecision) {
  localStorage.setItem(UPDATE_DECISION_KEY, JSON.stringify(decision))
  window.dispatchEvent(new CustomEvent("bezgrow:update-decision-changed", { detail: decision }))
}

export function clearUpdateDecision() {
  localStorage.removeItem(UPDATE_DECISION_KEY)
}

export function autoUpdateDue(decision: UpdateDecision, now = Date.now()) {
  const safeDeadline = decision.firstSeenAt + SAFE_AUTO_UPDATE_DELAY_MS
  return now >= safeDeadline || (decision.scheduledFor !== null && now >= decision.scheduledFor)
}

export function scheduleUpdate(version: string, scheduledFor: number) {
  const decision = readUpdateDecision(version)
  decision.scheduledFor = scheduledFor
  decision.nextPromptAt = scheduledFor
  writeUpdateDecision(decision)
  return decision
}

export function remindLater(version: string, now = Date.now()) {
  const decision = readUpdateDecision(version, now)
  decision.nextPromptAt = now + REMIND_LATER_DELAY_MS
  decision.scheduledFor = null
  writeUpdateDecision(decision)
  return decision
}
