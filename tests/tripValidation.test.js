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
