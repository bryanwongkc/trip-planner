import { describe, expect, it } from 'vitest'
import { formatDayDate, formatFullDayDate, nextDayDate, parseIsoDay } from '../src/utils/trip'
import { validateTripPatch } from '../src/utils/tripValidation'

describe('trip date handling', () => {
  it('renders invalid or empty day dates without throwing', () => {
    expect(formatDayDate('')).toBe('Date unset')
    expect(formatFullDayDate('2026-02-31')).toBe('Date unset')
    expect(parseIsoDay('2026-02-28')).toBeInstanceOf(Date)
  })

  it('ignores invalid days when choosing the next date', () => {
    expect(nextDayDate([{ date: '' }, { date: '2026-07-16' }])).toBe('2026-07-17')
  })

  it('rejects duplicate visible day dates', () => {
    expect(() =>
      validateTripPatch(
        { days: { one: { date: '2026-07-16' } } },
        { days: { two: { date: '2026-07-16' } } },
      ),
    ).toThrow(/different date/i)
  })

  it('measures the UTF-8 payload before it reaches Firestore document limits', () => {
    expect(() =>
      validateTripPatch(
        { days: { one: { date: '2026-07-16' } } },
        { items: { large: { description: '旅'.repeat(260_000) } } },
      ),
    ).toThrow(/too large/i)
  })
})
