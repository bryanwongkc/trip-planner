export const DEFAULT_INVITE_EXPIRY_DAYS = 7
export const DEFAULT_INVITE_MAX_USES = 10
export const MAX_INVITE_EXPIRY_DAYS = 30
export const MAX_INVITE_USES = 50

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

export function normalizeTripInviteOptions(options = {}) {
  return {
    expiresInDays: clampInteger(
      options.expiresInDays,
      DEFAULT_INVITE_EXPIRY_DAYS,
      1,
      MAX_INVITE_EXPIRY_DAYS,
    ),
    maxUses: clampInteger(options.maxUses, DEFAULT_INVITE_MAX_USES, 1, MAX_INVITE_USES),
  }
}

export function inviteTimestampToMillis(value) {
  if (!value) return null
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (value instanceof Date) return value.getTime()
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

export function tripInviteStatus(invite, now = Date.now()) {
  if (!invite) return 'invalid'
  if (invite.revokedAt) return 'revoked'
  const expiresAt = inviteTimestampToMillis(invite.expiresAt)
  if (expiresAt !== null && expiresAt <= now) return 'expired'
  if (Number(invite.useCount || 0) >= Number(invite.maxUses || 0)) return 'exhausted'
  return invite.active ? 'active' : 'inactive'
}
