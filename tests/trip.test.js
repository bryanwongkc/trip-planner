import { describe, expect, it } from 'vitest'
import {
  formatDayDate,
  formatFullDayDate,
  getScheduleConflicts,
  nextDayDate,
  parseIsoDay,
} from '../src/utils/trip'
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

describe('schedule travel-time conflicts', () => {
  const items = [
    {
      id: 'museum',
      dayId: 'day-a',
      title: 'Museum',
      startTime: '10:00',
      endTime: '11:00',
    },
    {
      id: 'lunch',
      dayId: 'day-a',
      title: 'Lunch',
      startTime: '11:20',
      endTime: '12:30',
    },
  ]

  function routeTaking(durationMin) {
    return {
      museum: {
        from: items[0],
        to: items[1],
        mode: 'walking',
        route: { durationMin, estimated: true },
      },
    }
  }

  it('flags an adjacent pair when the displayed travel duration exceeds the available gap', () => {
    const result = getScheduleConflicts(items, routeTaking(25.4))
    const conflict = result.conflicts.find((entry) => entry.type === 'insufficient_travel_time')

    expect(conflict).toMatchObject({
      itemIds: ['museum', 'lunch'],
      availableMinutes: 20,
      travelMinutes: 25,
      shortfallMinutes: 5,
      mode: 'walking',
    })
    expect(conflict.message).toContain('Walking from Museum to Lunch takes about 25 minutes')
    expect(result.byItemId.museum).toContain(conflict)
    expect(result.byItemId.lunch).toContain(conflict)
  })

  it('allows an exact-fit gap using the same rounded duration shown in the timeline', () => {
    const result = getScheduleConflicts(items, routeTaking(20.4))

    expect(result.conflicts).toEqual([])
  })

  it('ignores a stale route segment that points to a different next stop', () => {
    const routeSegmentMap = routeTaking(30)
    routeSegmentMap.museum.to = { ...items[1], id: 'dinner' }

    expect(getScheduleConflicts(items, routeSegmentMap).conflicts).toEqual([])
  })
})
