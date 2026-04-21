function parseCoordinateText(value) {
  const match = value.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/)
  if (!match) return null

  return {
    lat: Number(match[1]),
    lng: Number(match[2]),
  }
}

function parseGoogleMapsUrl(rawUrl) {
  let url

  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const latLngMatch = url.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
  if (latLngMatch) {
    return {
      label: decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'Google Maps pin'),
      lat: Number(latLngMatch[1]),
      lng: Number(latLngMatch[2]),
    }
  }

  const queryCandidates = [
    url.searchParams.get('query'),
    url.searchParams.get('q'),
    url.searchParams.get('ll'),
    url.searchParams.get('destination'),
  ].filter(Boolean)

  for (const candidate of queryCandidates) {
    const coordinates = parseCoordinateText(candidate)
    if (coordinates) {
      return {
        label: 'Google Maps pin',
        ...coordinates,
      }
    }
  }

  const pathSegments = url.pathname.split('/').filter(Boolean)
  const placeIndex = pathSegments.findIndex((segment) => segment === 'place')
  if (placeIndex >= 0 && pathSegments[placeIndex + 1]) {
    return {
      query: decodeURIComponent(pathSegments[placeIndex + 1]).replace(/\+/g, ' '),
    }
  }

  if (queryCandidates.length) {
    return {
      query: queryCandidates[0],
    }
  }

  return null
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' })
    return
  }

  const rawUrl = request.query?.url
  if (!rawUrl) {
    response.status(400).json({ error: 'Missing url parameter' })
    return
  }

  try {
    const upstream = await fetch(rawUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'trip-planner-map-resolver',
      },
    })

    const finalUrl = upstream.url || rawUrl
    const parsed = parseGoogleMapsUrl(finalUrl)

    if (!parsed) {
      response.status(200).json({ finalUrl })
      return
    }

    response.status(200).json({
      finalUrl,
      ...parsed,
    })
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to resolve map link',
    })
  }
}
