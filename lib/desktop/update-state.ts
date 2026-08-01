export const UPDATE_DECISION_KEY = "bezgrow.desktop-update-decision.v1"
export const UPDATE_INSTALL_EVENT = "bezgrow:install-update"
export const UPDATE_CHECK_EVENT = "bezgrow:check-update"

export const SAFE_AUTO_UPDATE_DELAY_MS = 48 * 60 * 60 * 1000
export const REMIND_LATER_DELAY_MS = 6 * 60 * 60 * 1000

export type UpdateDecision = {
  version: string
  firstSeenAt: number
  nextPromptAt: number
  scheduledFor: number | null
  lastAttemptAt: number | null
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
