export function mergeTripEntityMaps(current = {}, patch = {}) {
  return Object.fromEntries(
    ['days', 'items', 'bookingOptions'].map((key) => [
      key,
      { ...(current?.[key] || {}), ...(patch?.[key] || {}) },
    ]),
  )
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
