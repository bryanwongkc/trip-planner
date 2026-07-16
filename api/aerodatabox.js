/* global process */

const AERODATABOX_HOST =
  process.env.AERODATABOX_RAPIDAPI_HOST || 'aerodatabox.p.rapidapi.com'
const FLIGHT_NUMBER_PATTERN = /^(?=[A-Z0-9]{2,3}\d{1,4}[A-Z]?$)(?=[A-Z0-9]*[A-Z])[A-Z0-9]+$/
const requestWindows = new Map()
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 20
const UPSTREAM_TIMEOUT_MS = 8_000

function getApiKey() {
  return process.env.AERODATABOX_RAPIDAPI_KEY || ''
}

export function normalizeFlightQuery(query = {}) {
  const flightNumber = String(query.flightNumber || '').trim().toUpperCase()
  const date = String(query.date || '').trim()
  if (!FLIGHT_NUMBER_PATTERN.test(flightNumber)) return null

  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    const parsed = new Date(`${date}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  }

  return {
    flightNumber,
    date,
    withAircraftImage: String(query.withAircraftImage || 'false') === 'true',
    withLocation: String(query.withLocation || 'false') === 'true',
  }
}

export function buildUpstreamUrl(requestQuery = {}) {
  if (String(requestQuery.resource || '') !== 'flight-status') return null
  const query = normalizeFlightQuery(requestQuery)
  if (!query) return null

  const datePath = query.date ? `/${encodeURIComponent(query.date)}` : ''
  const params = new URLSearchParams({
    withAircraftImage: String(query.withAircraftImage),
    withLocation: String(query.withLocation),
  })
  return `https://${AERODATABOX_HOST}/flights/number/${encodeURIComponent(query.flightNumber)}${datePath}?${params.toString()}`
}

function getClientKey(request) {
  const forwarded = String(request.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || request.socket?.remoteAddress || 'unknown'
}

function isRateLimited(key, now = Date.now()) {
  for (const [candidate, window] of requestWindows) {
    if (now - window.startedAt >= RATE_WINDOW_MS) requestWindows.delete(candidate)
  }
  const window = requestWindows.get(key)
  if (!window) {
    requestWindows.set(key, { count: 1, startedAt: now })
    return false
  }
  window.count += 1
  return window.count > RATE_LIMIT
}

export default async function handler(request, response) {
  response.setHeader?.('Cache-Control', 's-maxage=300, stale-while-revalidate=600')
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' })
    return
  }
  if (isRateLimited(getClientKey(request))) {
    response.setHeader?.('Retry-After', '60')
    response.status(429).json({ error: 'Too many flight lookups. Please try again shortly.' })
    return
  }

  const apiKey = getApiKey()
  if (!apiKey) {
    response.status(503).json({ error: 'Flight status is not configured' })
    return
  }

  const upstreamUrl = buildUpstreamUrl(request.query || {})
  if (!upstreamUrl) {
    response.status(400).json({ error: 'Invalid flight status request' })
    return
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'x-rapidapi-host': AERODATABOX_HOST,
        'x-rapidapi-key': apiKey,
      },
    })
    const payload = await upstream.json().catch(() => null)

    if (!upstream.ok) {
      response.status(upstream.status === 429 ? 429 : 502).json({
        error: upstream.status === 429 ? 'Flight status quota is temporarily exhausted' : 'Flight status request failed',
      })
      return
    }
    response.status(200).json(payload)
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    response.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'Flight status request timed out' : 'Flight status request failed',
    })
  }
}
