/* global process */

const AERODATABOX_HOST =
  process.env.AERODATABOX_RAPIDAPI_HOST || 'aerodatabox.p.rapidapi.com'

function getApiKey() {
  return process.env.AERODATABOX_RAPIDAPI_KEY || ''
}

function buildFlightPath(query) {
  const flightNumber = String(query.flightNumber || '').trim().toUpperCase()
  const date = String(query.date || '').trim()

  if (!flightNumber) {
    return null
  }

  return date
    ? `/flights/number/${encodeURIComponent(flightNumber)}/${encodeURIComponent(date)}`
    : `/flights/number/${encodeURIComponent(flightNumber)}`
}

function buildUpstreamUrl(requestQuery) {
  const resource = String(requestQuery.resource || '').trim()

  if (resource === 'balance') {
    return `https://${AERODATABOX_HOST}/subscriptions/balance`
  }

  if (resource === 'flight-status') {
    const path = buildFlightPath(requestQuery)
    if (!path) return null

    const params = new URLSearchParams()
    params.set('withAircraftImage', String(requestQuery.withAircraftImage || 'false'))
    params.set('withLocation', String(requestQuery.withLocation || 'false'))

    return `https://${AERODATABOX_HOST}${path}?${params.toString()}`
  }

  return null
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' })
    return
  }

  const apiKey = getApiKey()
  if (!apiKey) {
    response.status(500).json({ error: 'AeroDataBox API key is not configured' })
    return
  }

  const upstreamUrl = buildUpstreamUrl(request.query || {})
  if (!upstreamUrl) {
    response.status(400).json({ error: 'Unsupported or incomplete AeroDataBox request' })
    return
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-rapidapi-host': AERODATABOX_HOST,
        'x-rapidapi-key': apiKey,
      },
    })

    const payload = await upstream.json().catch(() => null)

    if (!upstream.ok) {
      response.status(upstream.status).json({
        error: payload?.message || payload?.error || 'AeroDataBox request failed',
      })
      return
    }

    response.status(200).json(payload)
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'AeroDataBox request failed',
    })
  }
}
