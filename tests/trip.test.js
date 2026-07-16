import { describe, expect, it } from 'vitest'
import { formatDayDate, formatFullDayDate, nextDayDate, parseIsoDay } from '../src/utils/trip'
import { assertTripPatchIsCurrent, validateTripPatch } from '../src/utils/tripValidation'

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

describe('trip patch concurrency', () => {
  const beforeReorder = {
    items: {
      first: { id: 'first', dayId: 'day-a', order: 0, title: 'First', updatedAt: 'version-1' },
      second: { id: 'second', dayId: 'day-a', order: 1, title: 'Second', updatedAt: 'version-1' },
    },
  }
  const forwardReorder = {
    items: {
      first: { ...beforeReorder.items.first, order: 1 },
      second: { ...beforeReorder.items.second, order: 0 },
    },
  }
  const savedReorder = {
    items: {
      first: { ...forwardReorder.items.first, updatedAt: 'version-2' },
      second: { ...forwardReorder.items.second, updatedAt: 'version-2' },
    },
  }

  it('allows an inverse patch when Firestore contains the associated forward reorder', () => {
    expect(() =>
      assertTripPatchIsCurrent(savedReorder, beforeReorder, forwardReorder),
    ).not.toThrow()
  })

  it('still rejects undo after a real intervening edit', () => {
    const remotelyEdited = {
      items: {
        ...savedReorder.items,
        first: { ...savedReorder.items.first, title: 'Changed elsewhere', updatedAt: 'version-3' },
      },
    }

    expect(() =>
      assertTripPatchIsCurrent(remotelyEdited, beforeReorder, forwardReorder),
    ).toThrow(/another device/i)
  })

  it('rejects an ordinary stale patch without an explicit expected state', () => {
    expect(() => assertTripPatchIsCurrent(savedReorder, beforeReorder)).toThrow(/another device/i)
  })
})
