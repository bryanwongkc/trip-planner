// Shared by the browser and authenticated write API. Never trust stored records
// merely because their outer container is a Firestore map.
const stringFields = {
  days: ['id', 'date', 'name'],
  items: ['id', 'dayId', 'date', 'title', 'category', 'flightCode', 'locationName', 'address', 'startTime', 'endTime', 'endTimeMode', 'description', 'bookingRef', 'status', 'cancellationDeadline', 'travelModeToNext', 'placeId', 'sourceItemId', 'substituteGroupId', 'substituteOfItemId'],
  bookingOptions: ['id', 'linkedItemId', 'dayId', 'type', 'title', 'provider', 'bookingRef', 'status', 'startDate', 'endDate', 'reservationTime', 'cancellationDeadline', 'cancellationPolicy', 'currency', 'notes'],
}
const numberFields = { days: ['order'], items: ['order', 'durationMinutes', 'lat', 'lng'], bookingOptions: ['partySize', 'price'] }
const booleanFields = { days: ['hidden'], items: ['hidden', 'generated'], bookingOptions: ['hidden'] }
const derivedFields = new Set(['dayDate', 'dayLabel', 'dayNumber', 'items', 'label'])
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
export const ENTITY_KINDS = ['days', 'items', 'bookingOptions']

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validEntityId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/.test(id) && !unsafeKeys.has(id)
}

export function validIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validNested(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= 20_000
  if (typeof value === 'number') return Number.isFinite(value)
  return depth < 3 && isRecord(value) && Object.entries(value).every(([key, child]) =>
    !unsafeKeys.has(key) && validNested(child, depth + 1))
}

function legacyNumber(value) {
  if (typeof value !== 'string') return value
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

function legacyDetails(key, value) {
  if (!isRecord(value)) return value
  const details = { ...value }
  if (key === 'transit' && typeof details.approxDurationMinutes === 'number' && Number.isFinite(details.approxDurationMinutes)) {
    details.approxDurationMinutes = String(details.approxDurationMinutes)
  }
  if (key === 'flightInfo') {
    for (const field of ['departureAirportLocation', 'arrivalAirportLocation']) {
      if (!isRecord(details[field])) continue
      details[field] = { ...details[field], lat: legacyNumber(details[field].lat), lng: legacyNumber(details[field].lng) }
    }
  }
  return details
}

export function cleanEntity(kind, id, entity, { legacy = false } = {}) {
  if (!validEntityId(id) || !isRecord(entity)) throw new Error(`Invalid ${kind} record.`)
  const clean = {}
  for (const [key, originalValue] of Object.entries(entity)) {
    let value = originalValue
    if (unsafeKeys.has(key)) throw new Error(`Invalid ${kind} field.`)
    if (value === undefined || derivedFields.has(key)) continue
    if (key === 'updatedAt') { clean[key] = value; continue }
    const text = stringFields[kind].includes(key)
    const number = numberFields[kind].includes(key)
    const bool = booleanFields[kind].includes(key)
    const details = kind === 'items' && ['transit', 'flightInfo'].includes(key)
    // Older clients saved optional nulls, numeric text, and extra metadata.
    // Project those records for display without loosening new-write validation.
    if (legacy) {
      if (!text && !number && !bool && !details) continue
      if (text && value === null) value = key === 'id' ? id : ''
      if (number) value = legacyNumber(value)
      if (bool && value === null) value = false
      if (details) value = legacyDetails(key, value)
    }
    if (text && typeof value === 'string' && value.length <= 20_000) clean[key] = value
    else if (number && (value === null || (typeof value === 'number' && Number.isFinite(value)))) clean[key] = value
    else if (bool && typeof value === 'boolean') clean[key] = value
    else if (details && (value === null || isRecord(value)) && validNested(value)) {
      // Nested display fields are strings except known coordinate containers.
      if (value && Object.entries(value).some(([field, child]) =>
        !['departureAirportLocation', 'arrivalAirportLocation'].includes(field) && typeof child !== 'string' && child !== null)) {
        throw new Error(`Invalid ${key} field.`)
      }
      if (value && ['departureAirportLocation', 'arrivalAirportLocation'].some(field => value[field] != null &&
        (!isRecord(value[field]) || !['lat', 'lng'].every(axis => value[field][axis] === null || (typeof value[field][axis] === 'number' && Number.isFinite(value[field][axis])))))) {
        throw new Error('Invalid airport coordinates.')
      }
      clean[key] = value
    } else throw new Error(`Invalid ${kind}.${key} field.`)
  }
  if (clean.id && clean.id !== id) throw new Error('Record ID does not match its key.')
  for (const key of ['dayId', 'linkedItemId', 'sourceItemId', 'substituteGroupId', 'substituteOfItemId']) {
    if (clean[key] && !validEntityId(clean[key])) throw new Error('Invalid related record ID.')
  }
  if (kind === 'days' && !clean.hidden && !validIsoDate(clean.date)) throw new Error('Every itinerary day needs a valid date.')
  if (kind === 'items') {
    if (clean.category && !['Car', 'Activity', 'Restaurant', 'Transport', 'Flight', 'Hotel', 'Others'].includes(clean.category)) throw new Error('Invalid itinerary category.')
    for (const key of ['startTime', 'endTime']) {
      if (clean[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(clean[key])) throw new Error('Invalid itinerary time.')
    }
    if (clean.lat != null && (clean.lat < -90 || clean.lat > 90)) throw new Error('Invalid latitude.')
    if (clean.lng != null && (clean.lng < -180 || clean.lng > 180)) throw new Error('Invalid longitude.')
  }
  return clean
}

export function sanitizeTripSnapshot(value) {
  const result = { days: {}, items: {}, bookingOptions: {} }
  let invalidCount = 0
  for (const kind of ENTITY_KINDS) {
    if (value?.[kind] != null && !isRecord(value[kind])) { invalidCount++; continue }
    for (const [id, entity] of Object.entries(value?.[kind] || {})) {
      try { result[kind][id] = cleanEntity(kind, id, entity, { legacy: true }) } catch { invalidCount++ }
    }
  }
  return { data: result, invalidCount }
}

export function tripDateRange(days = {}) {
  const dates = Object.values(days).filter(day => !day.hidden && validIsoDate(day.date)).map(day => day.date).sort()
  return { startDate: dates[0] || '', endDate: dates.at(-1) || '' }
}
