import { describe, expect, it } from 'vitest'
import { assertTripPatchIsCurrent, getExpectedTripPatchState, validateTripPatch } from '../src/utils/tripValidation'
import { sanitizeTripSnapshot, tripDateRange } from '../src/utils/tripSchema'
import { deriveTripState } from '../src/utils/trip'

describe('trip schema and concurrency', () => {
  it('does not let a refreshed snapshot silently authorize an older open draft', () => {
    const original = { id: 'stop', title: 'Original', updatedAt: { seconds: 1, nanoseconds: 0 } }
    const current = { items: { stop: { ...original, title: 'Collaborator edit', updatedAt: { seconds: 2, nanoseconds: 0 } } } }
    const patch = { items: { stop: { ...original, title: 'Old draft' } } }
    expect(() => getExpectedTripPatchState(current, patch)).toThrow('changed on another device')
    const expected = getExpectedTripPatchState(current, patch, { items: { stop: original } })
    expect(() => assertTripPatchIsCurrent(current, patch, expected)).toThrow('changed on another device')
  })

  it('compares record content after offline timestamps are serialized and checks new-record collisions', () => {
    const current = { items: { stop: { title: 'First', updatedAt: { seconds: 2 } } } }
    expect(() => assertTripPatchIsCurrent(current, { items: { stop: { title: 'Second' } } }, { items: { stop: { title: 'First', updatedAt: { seconds: 1 } } } })).not.toThrow()
    expect(() => assertTripPatchIsCurrent(current, { items: { stop: { title: 'Collision' } } }, { items: { stop: null } })).toThrow()
  })

  it('accepts undo baselines with display-only fields without overlooking real changes', () => {
    const saved = { id: 'stop', title: 'Moved', dayId: 'day', order: 1 }
    const current = { items: { stop: saved } }
    const undo = { items: { stop: { ...saved, order: 0 } } }
    const expected = getExpectedTripPatchState(current, undo, { items: { stop: { ...saved, dayDate: '2026-10-02', dayLabel: 'Day 1' } } })
    expect(() => assertTripPatchIsCurrent(current, undo, expected)).not.toThrow()
    expect(() => assertTripPatchIsCurrent({ items: { stop: { ...saved, title: 'Changed' } } }, undo, expected)).toThrow()
  })

  it.each([42, {}, ['10:00']])('rejects malformed time %j and safely renders the remaining records', startTime => {
    const payload = { days: { day: { date: '2026-10-02' } }, items: { good: { title: 'Safe', dayId: 'day', startTime: '10:00' }, bad: { startTime } } }
    expect(() => validateTripPatch({}, payload)).toThrow()
    const safe = sanitizeTripSnapshot(payload)
    expect(safe.invalidCount).toBe(1)
    expect(() => deriveTripState(safe.data, { includeSeed: false })).not.toThrow()
    expect(safe.data.items.good.title).toBe('Safe')
  })

  it('computes dates independently of day order', () => {
    expect(tripDateRange({ a: { date: '2026-12-02', order: 0 }, b: { date: '2026-11-01', order: 1 }, c: { date: '2020-01-01', hidden: true } })).toEqual({ startDate: '2026-11-01', endDate: '2026-12-02' })
  })

  it('rejects prototype names used as related record IDs or display categories', () => {
    for (const bad of [{ dayId: 'constructor' }, { category: '__proto__' }]) {
      const input = { days: { day: { date: '2026-10-02' } }, items: { bad } }
      expect(() => validateTripPatch({}, input)).toThrow()
      expect(() => deriveTripState(sanitizeTripSnapshot(input).data, { includeSeed: false })).not.toThrow()
    }
  })
})

describe('legacy trip compatibility', () => {
  it.each(['Shopping', 'Wedding'])('preserves historical %s records in visible and hidden items', category => {
    for (const hidden of [false, true]) {
      const raw = {
        days: { day: { id: 'day', date: '2026-10-02' } },
        items: { stop: { id: 'stop', dayId: 'day', title: 'Historical stop', category, hidden } },
        bookingOptions: {},
      }
      const safe = sanitizeTripSnapshot(raw)
      expect(safe.invalidCount).toBe(0)
      expect(safe.data).toEqual(raw)
      const view = deriveTripState(safe.data, { includeSeed: false })
      expect(view.items).toHaveLength(hidden ? 0 : 1)
      expect(validateTripPatch(safe.data, { items: { stop: { title: 'Edited' } } }).items.stop).toMatchObject({ category, hidden })
    }
  })

  it('does not bypass category validation for hidden records', () => {
    for (const category of ['Unrecognized', 'constructor', '__proto__']) {
      const raw = { items: { stop: { category, hidden: true } } }
      expect(sanitizeTripSnapshot(raw).invalidCount).toBe(1)
      expect(() => validateTripPatch({}, raw)).toThrow('Invalid itinerary category')
    }
  })

  it('reads older records without hiding them or mutating their stored representation', () => {
    const raw = {
      days: { day: { id: 'day', date: '2026-10-02', name: null, order: '0', hidden: null, legacyColor: 'blue' } },
      items: {
        stop: {
          id: null, dayId: 'day', title: 'Legacy stop', description: null, bookingRef: null,
          startTime: '10:00', endTime: null, category: 'Transport', durationMinutes: '45',
          lat: '35.5', lng: '139.5', generated: null,
          transit: { mode: 'train', approxDurationMinutes: 45, notes: null },
          legacyDetails: { imported: true, labels: ['keep'] },
        },
        flight: { dayId: 'day', category: 'Flight', flightInfo: { departureAirportLocation: { lat: '35.5', lng: '139.5' } } },
      },
      bookingOptions: { booking: { id: 'booking', linkedItemId: 'stop', title: 'Legacy booking', price: '125.50', partySize: '2', notes: null } },
    }
    const original = structuredClone(raw)
    const safe = sanitizeTripSnapshot(raw)
    expect(safe.invalidCount).toBe(0)
    expect(safe.data.days.day).toEqual({ id: 'day', date: '2026-10-02', name: '', order: 0, hidden: false })
    expect(safe.data.items.stop).toMatchObject({ id: 'stop', description: '', endTime: '', durationMinutes: 45, lat: 35.5, lng: 139.5, generated: false, transit: { approxDurationMinutes: '45' } })
    expect(safe.data.items.stop).not.toHaveProperty('legacyDetails')
    expect(safe.data.items.flight.flightInfo.departureAirportLocation).toEqual({ lat: 35.5, lng: 139.5 })
    expect(safe.data.bookingOptions.booking).toMatchObject({ price: 125.5, partySize: 2, notes: '' })
    expect(deriveTripState(safe.data, { includeSeed: false }).items.map(item => item.id)).toContain('stop')
    expect(raw).toEqual(original)
    expect(sanitizeTripSnapshot(safe.data)).toEqual(safe)
    expect(() => validateTripPatch(safe.data, { items: { stop: { title: 'Edited' } } })).not.toThrow()
  })

  it.each([
    { description: null },
    { durationMinutes: '45' },
    { hidden: null },
    { legacyDetails: { imported: true } },
    { transit: { approxDurationMinutes: 45 } },
  ])('normalizes saved %j while keeping new writes strict', legacy => {
    const raw = { items: { stop: { title: 'Stop', ...legacy } } }
    expect(sanitizeTripSnapshot(raw).invalidCount).toBe(0)
    expect(() => validateTripPatch({}, raw)).toThrow()
    expect(() => validateTripPatch(sanitizeTripSnapshot(raw).data, raw)).toThrow()
  })

  it.each([
    { durationMinutes: 'not a number' },
    { durationMinutes: Infinity },
    { lat: '91' },
    { startTime: '25:00' },
    { title: { nested: 'not text' } },
    { transit: { approxDurationMinutes: [] } },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ])('continues to quarantine unsafe saved fields %j', fields => {
    const safe = sanitizeTripSnapshot({ items: { bad: fields, good: { title: 'Safe' } } })
    expect(safe.invalidCount).toBe(1)
    expect(Object.keys(safe.data.items)).toEqual(['good'])
    expect(() => validateTripPatch({}, { items: { bad: fields } })).toThrow()
  })
})
