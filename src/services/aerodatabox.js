const FLIGHT_NUMBER_PATTERN = /\b([A-Z0-9]{2,3})\s*(\d{1,4}[A-Z]?)\b/gi

export function extractFlightNumber(value = '') {
  const normalized = String(value).trim().toUpperCase()
  if (!normalized) return ''

  for (const match of normalized.matchAll(FLIGHT_NUMBER_PATTERN)) {
    if (/[A-Z]/.test(match[1])) return `${match[1]}${match[2]}`
  }

  return ''
}

export function getFlightCodeInputValue(item) {
  if (!item) return ''
  if (Object.prototype.hasOwnProperty.call(item, 'flightCode')) {
    return String(item.flightCode || '')
  }
  return extractFlightNumber(item.title || item.bookingRef || '')
}

export function stripFlightInfoDescription(description = '') {
  return String(description)
    .replace(/\n?\n?(?:\[Flight details\]\n)?Departure:[\s\S]*$/u, '')
    .trimEnd()
}

export function buildFlightCodeChangePatch(item, value) {
  const flightCode = String(value || '').toUpperCase().replace(/\s+/g, '')
  if (flightCode === getFlightCodeInputValue(item)) return { flightCode }

  return {
    flightCode,
    title: flightCode ? `Flight (${flightCode})` : 'Flight',
    startTime: '',
    endTime: '',
    endTimeMode: 'time',
    durationMinutes: null,
    description: stripFlightInfoDescription(item?.description),
    flightInfo: null,
  }
}

export function inferFlightLookupFromItem(item) {
  if (!item || item.category !== 'Flight') return null

  const flightNumber = extractFlightNumber(getFlightCodeInputValue(item))
  if (!flightNumber) return null

  return {
    flightNumber,
    date: item.dayDate || '',
  }
}

export function normalizeFlightStatusPayload(payload) {
  const entries = Array.isArray(payload?.departures)
    ? payload.departures
    : Array.isArray(payload?.arrivals)
      ? payload.arrivals
      : Array.isArray(payload)
        ? payload
        : payload
          ? [payload]
          : []

  return entries.map((entry) => ({
    number: entry?.number || '',
    status: entry?.status || '',
    codeshareStatus: entry?.codeshareStatus || '',
    lastUpdatedUtc: entry?.lastUpdatedUtc || '',
    airline: entry?.airline?.name || '',
    aircraftModel: entry?.aircraft?.model || '',
    departureAirport: entry?.departure?.airport?.iata || entry?.departure?.airport?.icao || '',
    arrivalAirport: entry?.arrival?.airport?.iata || entry?.arrival?.airport?.icao || '',
    departureAirportName: entry?.departure?.airport?.name || '',
    arrivalAirportName: entry?.arrival?.airport?.name || '',
    departureAirportLocation: {
      lat: entry?.departure?.airport?.location?.lat ?? null,
      lng: entry?.departure?.airport?.location?.lon ?? entry?.departure?.airport?.location?.lng ?? null,
    },
    arrivalAirportLocation: {
      lat: entry?.arrival?.airport?.location?.lat ?? null,
      lng: entry?.arrival?.airport?.location?.lon ?? entry?.arrival?.airport?.location?.lng ?? null,
    },
    departureTerminal: entry?.departure?.terminal || '',
    arrivalTerminal: entry?.arrival?.terminal || '',
    departureGate: entry?.departure?.gate || '',
    arrivalGate: entry?.arrival?.gate || '',
    scheduledDeparture: entry?.departure?.scheduledTime?.local || '',
    scheduledArrival: entry?.arrival?.scheduledTime?.local || '',
    raw: entry,
  }))
}

function flightRecordRank(record) {
  const hasCompleteRoute = Boolean(record?.departureAirport && record?.arrivalAirport)
  const hasCompleteSchedule = Boolean(record?.scheduledDeparture && record?.scheduledArrival)
  const coreFieldCount = [
    record?.departureAirport,
    record?.arrivalAirport,
    record?.scheduledDeparture,
    record?.scheduledArrival,
  ].filter(Boolean).length
  const isOperatingFlight = record?.codeshareStatus === 'IsOperator'
  const updatedValue = String(record?.lastUpdatedUtc || '').replace(' ', 'T')
  const updatedAt = Date.parse(updatedValue)

  return [
    Number(hasCompleteRoute),
    Number(hasCompleteSchedule),
    coreFieldCount,
    Number.isNaN(updatedAt) ? 0 : updatedAt,
    Number(isOperatingFlight),
  ]
}

function compareFlightRecordRank(left, right) {
  const leftRank = flightRecordRank(left)
  const rightRank = flightRecordRank(right)

  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) return rightRank[index] - leftRank[index]
  }

  return 0
}

export function selectFlightRecord(records, flightCode) {
  if (!Array.isArray(records) || !records.length) return null

  const normalizedCode = extractFlightNumber(flightCode)
  const exactMatches = normalizedCode
    ? records.filter((record) => extractFlightNumber(record?.number || '') === normalizedCode)
    : []
  const candidates = exactMatches.length ? exactMatches : records

  return [...candidates].sort(compareFlightRecordRank)[0] || null
}

async function requestAeroDataBox(params) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value))
    }
  })

  const response = await fetch(`/api/aerodatabox?${search.toString()}`)
  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(payload?.error || 'AeroDataBox request failed')
  }

  return payload
}

export async function fetchFlightStatusByNumber({
  date,
  flightNumber,
  withAircraftImage = false,
  withLocation = false,
}) {
  const payload = await requestAeroDataBox({
    resource: 'flight-status',
    flightNumber,
    date,
    withAircraftImage,
    withLocation,
  })

  return {
    records: normalizeFlightStatusPayload(payload),
    raw: payload,
  }
}
