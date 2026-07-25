export function mergeTripEntityMaps(current = {}, patch = {}) {
  return Object.fromEntries(
    ['days', 'items', 'bookingOptions'].map((key) => {
      const currentEntities = current?.[key] || {}
      const patchEntities = patch?.[key] || {}
      return [
        key,
        Object.fromEntries(
          [...new Set([...Object.keys(currentEntities), ...Object.keys(patchEntities)])].map((id) => [
            id,
            { ...(currentEntities[id] || {}), ...(patchEntities[id] || {}) },
          ]),
        ),
      ]
    }),
  )
}

export const TRIP_VERSION_CONFLICT_CODE = 'trip-version-conflict'

export function getExpectedTripPatchState(current = {}, patch = {}, explicitExpected) {
  if (explicitExpected) return explicitExpected

  return Object.fromEntries(
    ['days', 'items', 'bookingOptions'].map((key) => [
      key,
      Object.fromEntries(
        Object.keys(patch?.[key] || {}).flatMap((id) => {
          const entity = current?.[key]?.[id]
          return entity ? [[id, entity]] : []
        }),
      ),
    ]),
  )
}

function timestampsMatch(left, right) {
  if (!left || !right) return true
  if (typeof left.isEqual === 'function') return left.isEqual(right)
  if (typeof left.toMillis === 'function' && typeof right.toMillis === 'function') {
    return left.toMillis() === right.toMillis()
  }
  return String(left) === String(right)
}

function normalizeComparableValue(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (typeof value.toMillis === 'function') return value.toMillis()
  if (Array.isArray(value)) return value.map(normalizeComparableValue)

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nestedValue]) => nestedValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, nestedValue]) => [key, normalizeComparableValue(nestedValue)]),
  )
}

function entitiesMatchIgnoringUpdatedAt(left, right) {
  if (!left || !right) return false
  const withoutTimestamp = (entity) => {
    const { updatedAt: _updatedAt, ...rest } = entity
    return normalizeComparableValue(rest)
  }
  return JSON.stringify(withoutTimestamp(left)) === JSON.stringify(withoutTimestamp(right))
}

export function assertTripPatchIsCurrent(current, patch, expectedCurrent = {}) {
  for (const key of ['days', 'items', 'bookingOptions']) {
    for (const [id, incoming] of Object.entries(patch[key] || {})) {
      const existing = current?.[key]?.[id]
      if (!incoming?.updatedAt || !existing?.updatedAt || timestampsMatch(incoming.updatedAt, existing.updatedAt)) {
        continue
      }

      const expectedEntity = expectedCurrent?.[key]?.[id]
      if (expectedEntity && entitiesMatchIgnoringUpdatedAt(existing, expectedEntity)) continue

      const error = new Error('This trip changed on another device. Review the latest version and try again.')
      error.code = TRIP_VERSION_CONFLICT_CODE
      throw error
    }
  }
}

export function validateTripPatch(current, patch) {
  const merged = mergeTripEntityMaps(current, patch)
  const visibleDates = Object.values(merged.days)
    .filter((day) => !day.hidden)
    .map((day) => String(day.date || ''))

  if (visibleDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error('Every itinerary day needs a valid date.')
  }
  if (new Set(visibleDates).size !== visibleDates.length) {
    throw new Error('Each itinerary day must use a different date.')
  }
  if (visibleDates.length > 120) throw new Error('A trip cannot exceed 120 days.')
  if (Object.keys(merged.items).length > 2_000) throw new Error('This trip has too many itinerary items.')
  if (Object.keys(merged.bookingOptions).length > 2_000) throw new Error('This trip has too many booking options.')
  const serializedBytes = new TextEncoder().encode(JSON.stringify(merged)).byteLength
  if (serializedBytes > 750_000) throw new Error('This trip is too large to save safely.')

  return merged
}
