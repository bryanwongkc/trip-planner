import { cleanEntity, ENTITY_KINDS, isRecord } from './tripSchema.js'

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
  return Object.fromEntries(
    ['days', 'items', 'bookingOptions'].map((key) => [
      key,
      Object.fromEntries(
        Object.keys(patch?.[key] || {}).map((id) => {
          const entity = current?.[key]?.[id]
          if (Object.hasOwn(explicitExpected?.[key] || {}, id)) {
            const expected = explicitExpected[key][id]
            return [id, expected == null ? null : cleanEntity(key, id, expected)]
          }
          const incoming = patch[key][id]
          if (incoming?.updatedAt && entity?.updatedAt && !timestampsMatch(incoming.updatedAt, entity.updatedAt)) {
            throw versionConflict()
          }
          return [id, entity || null]
        }),
      ),
    ]),
  )
}

function timestampsMatch(left, right) {
  if (!left || !right) return true
  const parts = value => [value.seconds ?? value._seconds, value.nanoseconds ?? value._nanoseconds]
  const a = parts(left), b = parts(right)
  if (a[0] !== undefined && b[0] !== undefined) return a[0] === b[0] && a[1] === b[1]
  return JSON.stringify(left) === JSON.stringify(right)
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
  if (!left || !right) return !left && !right
  const withoutTimestamp = (entity) => {
    const { updatedAt: _updatedAt, ...rest } = entity
    return normalizeComparableValue(rest)
  }
  return JSON.stringify(withoutTimestamp(left)) === JSON.stringify(withoutTimestamp(right))
}

function versionConflict() {
  const error = new Error('This trip changed on another device. Review the latest version and try again.')
  error.code = TRIP_VERSION_CONFLICT_CODE
  return error
}

export function assertTripPatchIsCurrent(current, patch, expectedCurrent = {}) {
  for (const key of ['days', 'items', 'bookingOptions']) {
    for (const [id, incoming] of Object.entries(patch[key] || {})) {
      const existing = current?.[key]?.[id]
      if (Object.hasOwn(expectedCurrent?.[key] || {}, id)) {
        if (!entitiesMatchIgnoringUpdatedAt(existing, expectedCurrent[key][id])) throw versionConflict()
        continue
      }
      if (!incoming?.updatedAt || !existing?.updatedAt || timestampsMatch(incoming.updatedAt, existing.updatedAt)) {
        continue
      }

      throw versionConflict()
    }
  }
}

export function validateTripPatch(current, patch) {
  if (!isRecord(patch) || Object.keys(patch).some(key => !ENTITY_KINDS.includes(key))) throw new Error('Invalid trip changes.')
  for (const kind of ENTITY_KINDS) {
    if (patch[kind] !== undefined && !isRecord(patch[kind])) throw new Error('Invalid trip changes.')
    if (Object.values(patch[kind] || {}).some(entity => !isRecord(entity))) throw new Error('Invalid trip record.')
  }
  const merged = mergeTripEntityMaps(current, patch)
  for (const kind of ENTITY_KINDS) {
    merged[kind] = Object.fromEntries(Object.entries(merged[kind]).map(([id, entity]) => [id, cleanEntity(kind, id, entity)]))
  }
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
