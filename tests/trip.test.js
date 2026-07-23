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

  it('flags an adjacent pair when the displayed travel duration exceeds the 10-minute tolerance', () => {
    const result = getScheduleConflicts(items, routeTaking(31.4))
    const conflict = result.conflicts.find((entry) => entry.type === 'insufficient_travel_time')

    expect(conflict).toMatchObject({
      itemIds: ['museum', 'lunch'],
      availableMinutes: 20,
      travelMinutes: 31,
      shortfallMinutes: 11,
      toleranceMinutes: 10,
      excessMinutes: 1,
      mode: 'walking',
    })
    expect(conflict.message).toContain('exceeds the 10-minute tolerance by 1 minute')
    expect(result.byItemId.museum).toContain(conflict)
    expect(result.byItemId.lunch).toContain(conflict)
  })

  it('allows travel to exceed the available gap by the full 10-minute tolerance', () => {
    const result = getScheduleConflicts(items, routeTaking(30.4))

    expect(result.conflicts).toEqual([])
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

  it('checks travel from the end of a linked hotel stay', () => {
    const linkedHotel = {
      id: 'generated-hotel:ota:day-a',
      dayId: 'day-a',
      title: 'Hotel Route-Inn Grand Ota Ekimae',
      category: 'Hotel',
      startTime: '00:00',
      endTime: '12:30',
      generated: true,
    }
    const airport = {
      id: 'narita-airport',
      dayId: 'day-a',
      title: 'Narita International Airport',
      category: 'Activity',
      startTime: '12:30',
      endTime: '15:00',
    }
    const routeSegmentMap = {
      [linkedHotel.id]: {
        from: linkedHotel,
        to: airport,
        mode: 'driving',
        route: { durationMin: 130 },
      },
    }

    const result = getScheduleConflicts([linkedHotel, airport], routeSegmentMap)
    const conflict = result.conflicts.find((entry) => entry.type === 'insufficient_travel_time')

    expect(conflict).toMatchObject({
      itemIds: [linkedHotel.id, airport.id],
      availableMinutes: 0,
      travelMinutes: 130,
      excessMinutes: 120,
    })
    expect(result.byItemId[linkedHotel.id]).toContain(conflict)
    expect(result.byItemId[airport.id]).toContain(conflict)
  })

  it('checks travel against a hotel start time', () => {
    const dinner = {
      id: 'dinner',
      dayId: 'day-a',
      title: 'Dinner',
      category: 'Restaurant',
      startTime: '20:00',
      endTime: '21:00',
    }
    const hotel = {
      id: 'hotel',
      dayId: 'day-a',
      title: 'Hotel',
      category: 'Hotel',
      startTime: '21:30',
      endTime: '23:59',
    }
    const routeSegmentMap = {
      [dinner.id]: {
        from: dinner,
        to: hotel,
        mode: 'driving',
        route: { durationMin: 45 },
      },
    }

    const result = getScheduleConflicts([dinner, hotel], routeSegmentMap)
    const conflict = result.conflicts.find((entry) => entry.type === 'insufficient_travel_time')

    expect(conflict).toMatchObject({
      itemIds: [dinner.id, hotel.id],
      availableMinutes: 30,
      travelMinutes: 45,
      excessMinutes: 5,
    })
    expect(result.byItemId[dinner.id]).toContain(conflict)
    expect(result.byItemId[hotel.id]).toContain(conflict)
  })
})
