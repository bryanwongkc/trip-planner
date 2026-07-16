import { describe, expect, it } from 'vitest'
import {
  GUEST_TRIP_STORAGE_KEY,
  LEGACY_GUEST_OVERRIDES_KEY,
  deleteGuestTrip,
  listGuestTripSummaries,
  readGuestTrip,
  saveGuestTrip,
} from '../src/utils/guestTrips'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  }
}

describe('guest trip persistence', () => {
  it('keeps multiple trips independently across reloads', () => {
    const storage = memoryStorage()
    saveGuestTrip(storage, 'trip-a', { title: 'A' }, { days: { a: { date: '2026-08-01' } } })
    saveGuestTrip(storage, 'trip-b', { title: 'B' }, { days: { b: { date: '2026-09-01' } } })

    expect(listGuestTripSummaries(storage).map((trip) => trip.id)).toEqual(['trip-a', 'trip-b'])
    expect(readGuestTrip(storage, 'trip-a').days.a.date).toBe('2026-08-01')
    expect(readGuestTrip(storage, 'trip-b').days.b.date).toBe('2026-09-01')
  })

  it('migrates the legacy single-trip value once without data loss', () => {
    const legacy = { days: { old: { date: '2026-07-16' } }, items: {}, bookingOptions: {} }
    const storage = memoryStorage({ [LEGACY_GUEST_OVERRIDES_KEY]: JSON.stringify(legacy) })

    const trip = readGuestTrip(storage, 'legacy-trip', {
      legacyTripId: 'legacy-trip',
      legacySummary: { title: 'Legacy' },
    })

    expect(trip.days.old.date).toBe('2026-07-16')
    expect(storage.getItem(LEGACY_GUEST_OVERRIDES_KEY)).toBeNull()
    expect(JSON.parse(storage.getItem(GUEST_TRIP_STORAGE_KEY)).version).toBe(2)
  })

  it('deletes only the selected guest trip', () => {
    const storage = memoryStorage()
    saveGuestTrip(storage, 'trip-a', { title: 'A' }, {})
    saveGuestTrip(storage, 'trip-b', { title: 'B' }, {})
    deleteGuestTrip(storage, 'trip-a')
    expect(listGuestTripSummaries(storage).map((trip) => trip.id)).toEqual(['trip-b'])
  })
})
