export const GUEST_TRIP_STORAGE_KEY = 'trip-planner-guest-trips-v2'
export const LEGACY_GUEST_OVERRIDES_KEY = 'trip-planner-temporary-overrides'
const STORE_VERSION = 2

export function emptyTripOverrides() {
  return { days: {}, items: {}, bookingOptions: {} }
}

function normalizeOverrides(value) {
  return {
    days: value?.days && typeof value.days === 'object' ? value.days : {},
    items: value?.items && typeof value.items === 'object' ? value.items : {},
    bookingOptions:
      value?.bookingOptions && typeof value.bookingOptions === 'object' ? value.bookingOptions : {},
  }
}

function emptyStore() {
  return { version: STORE_VERSION, trips: {} }
}

function writeStore(storage, store) {
  try {
    storage?.setItem(GUEST_TRIP_STORAGE_KEY, JSON.stringify(store))
    return true
  } catch {
    return false
  }
}

export function readGuestTripStore(storage, { legacyTripId = '', legacySummary = null } = {}) {
  try {
    const parsed = JSON.parse(storage?.getItem(GUEST_TRIP_STORAGE_KEY) || '')
    if (parsed?.version === STORE_VERSION && parsed.trips && typeof parsed.trips === 'object') {
      return parsed
    }
  } catch {
    // Fall through to the legacy migration or an empty store.
  }

  const store = emptyStore()
  try {
    const legacy = JSON.parse(storage?.getItem(LEGACY_GUEST_OVERRIDES_KEY) || '')
    if (legacyTripId && legacy && typeof legacy === 'object') {
      store.trips[legacyTripId] = {
        summary: { ...(legacySummary || {}), id: legacyTripId, role: 'owner' },
        overrides: normalizeOverrides(legacy),
        updatedAt: new Date().toISOString(),
      }
      if (writeStore(storage, store)) storage?.removeItem(LEGACY_GUEST_OVERRIDES_KEY)
    }
  } catch {
    // A malformed legacy value is ignored rather than breaking app startup.
  }
  return store
}

export function listGuestTripSummaries(storage, options) {
  return Object.values(readGuestTripStore(storage, options).trips)
    .map((trip) => trip.summary)
    .filter((summary) => summary?.id)
}

export function readGuestTrip(storage, tripId, options) {
  const trip = readGuestTripStore(storage, options).trips[tripId]
  return trip ? normalizeOverrides(trip.overrides) : emptyTripOverrides()
}

export function saveGuestTrip(storage, tripId, summary, overrides) {
  if (!storage || !tripId) return false
  const store = readGuestTripStore(storage)
  const existing = store.trips[tripId] || {}
  store.trips[tripId] = {
    summary: { ...(existing.summary || {}), ...(summary || {}), id: tripId, role: 'owner' },
    overrides: normalizeOverrides(overrides ?? existing.overrides),
    updatedAt: new Date().toISOString(),
  }
  return writeStore(storage, store)
}

export function deleteGuestTrip(storage, tripId) {
  const store = readGuestTripStore(storage)
  delete store.trips[tripId]
  return writeStore(storage, store)
}
