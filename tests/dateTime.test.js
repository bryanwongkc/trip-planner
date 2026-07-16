import { describe, expect, it } from 'vitest'
import { formatDateTimeForLocalInput, normalizeDateTimeForStorage } from '../src/utils/dateTime'

describe('cancellation deadline timestamps', () => {
  it('stores a datetime-local value as an unambiguous UTC instant', () => {
    const stored = normalizeDateTimeForStorage('2026-07-16T14:30')
    expect(stored).toMatch(/^2026-07-16T\d{2}:30:00\.000Z$/)
    expect(normalizeDateTimeForStorage(formatDateTimeForLocalInput(stored))).toBe(stored)
  })

  it('rejects invalid values rather than persisting ambiguous text', () => {
    expect(normalizeDateTimeForStorage('not-a-date')).toBe('')
    expect(formatDateTimeForLocalInput('not-a-date')).toBe('')
  })
})
