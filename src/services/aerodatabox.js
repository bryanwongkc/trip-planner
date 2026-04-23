const FLIGHT_NUMBER_PATTERNS = [
  /\(([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\)/i,
  /\b([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\b/i,
]

export function extractFlightNumber(value = '') {
  const normalized = String(value).trim().toUpperCase()
  if (!normalized) return ''

  for (const pattern of FLIGHT_NUMBER_PATTERNS) {
    const match = normalized.match(pattern)
    if (match?.[1]) return match[1]
  }

  return ''
}

export function inferFlightLookupFromItem(item) {
  if (!item || item.category !== 'Flight') return null

  const flightNumber = extractFlightNumber(item.flightCode || item.title || item.bookingRef || '')
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

export async function fetchAeroDataBoxBalance() {
  return requestAeroDataBox({ resource: 'balance' })
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
