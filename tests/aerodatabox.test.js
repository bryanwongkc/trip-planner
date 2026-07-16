// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { buildUpstreamUrl, normalizeFlightQuery } from '../api/aerodatabox'
import { extractFlightNumber } from '../src/services/aerodatabox'

describe('AeroDataBox request validation', () => {
  it('accepts airline flight numbers and rejects bare numbers', () => {
    expect(extractFlightNumber('CX 101')).toBe('CX101')
    expect(extractFlightNumber('1234')).toBe('')
    expect(normalizeFlightQuery({ flightNumber: 'U2123', date: '2026-07-16' })).toMatchObject({
      flightNumber: 'U2123',
    })
    expect(normalizeFlightQuery({ flightNumber: '1234', date: '2026-07-16' })).toBeNull()
  })

  it('does not expose the subscription balance resource', () => {
    expect(buildUpstreamUrl({ resource: 'balance' })).toBeNull()
    expect(buildUpstreamUrl({ resource: 'flight-status', flightNumber: 'CX101' })).toContain(
      '/flights/number/CX101',
    )
  })
})
