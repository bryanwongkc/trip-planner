import { describe, expect, it } from 'vitest'
import {
  normalizeTripInviteOptions,
  tripInviteStatus,
} from '../src/utils/tripInvites'

describe('trip invitation lifecycle', () => {
  it('normalizes expiry and usage limits', () => {
    expect(normalizeTripInviteOptions()).toEqual({ expiresInDays: 7, maxUses: 10 })
    expect(normalizeTripInviteOptions({ expiresInDays: 100, maxUses: 0 })).toEqual({
      expiresInDays: 30,
      maxUses: 1,
    })
  })

  it('distinguishes active, expired, exhausted, and revoked links', () => {
    const now = Date.parse('2026-07-16T00:00:00Z')
    const base = {
      active: true,
      expiresAt: new Date('2026-07-17T00:00:00Z'),
      maxUses: 2,
      useCount: 0,
    }

    expect(tripInviteStatus(base, now)).toBe('active')
    expect(tripInviteStatus({ ...base, expiresAt: new Date('2026-07-15T00:00:00Z') }, now)).toBe('expired')
    expect(tripInviteStatus({ ...base, useCount: 2 }, now)).toBe('exhausted')
    expect(tripInviteStatus({ ...base, revokedAt: new Date() }, now)).toBe('revoked')
  })
})
