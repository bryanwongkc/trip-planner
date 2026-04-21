const SEARCH_LIMIT = 5

const QUERY_ALIASES = new Map([
  [
    '龍宮城スパ・ホテル三日月 龍宮亭',
    [
      '龍宮城スパ・ホテル三日月 龍宮亭',
      '龍宮城スパホテル三日月 龍宮亭',
      '龍宮城スパ・ホテル三日月',
      '龍宮城SPA酒店三日月 龍宮亭',
      '龍宮城溫泉酒店三日月 龍宮亭',
      '龍宮城三日月酒店',
      'Ryugujo Spa Hotel Mikazuki Ryugutei',
      'Ryugujo Spa Hotel Mikazuki',
      'Hotel Mikazuki Ryugutei Kisarazu',
    ],
  ],
  [
    '龍宮城SPA酒店三日月 龍宮亭',
    [
      '龍宮城SPA酒店三日月 龍宮亭',
      '龍宮城溫泉酒店三日月 龍宮亭',
      '龍宮城三日月酒店',
      '龍宮城スパ・ホテル三日月 龍宮亭',
      'Ryugujo Spa Hotel Mikazuki Ryugutei',
    ],
  ],
  [
    '龍宮城溫泉酒店三日月 龍宮亭',
    [
      '龍宮城溫泉酒店三日月 龍宮亭',
      '龍宮城SPA酒店三日月 龍宮亭',
      '龍宮城三日月酒店',
      '龍宮城スパ・ホテル三日月 龍宮亭',
      'Ryugujo Spa Hotel Mikazuki Ryugutei',
    ],
  ],
])

function normalizeQuery(query) {
  return query
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[・･]/g, ' ')
    .replace(/[－–—]/g, '-')
}

function parseCoordinateText(value) {
  const match = value.match(/(-?\d+\.\d+),\s*(-?\d+\.\d+)/)
  if (!match) return null

  return {
    lat: Number(match[1]),
    lng: Number(match[2]),
  }
}

function parseGoogleDataPayload(value) {
  const coordinateMatch = value.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)
  if (!coordinateMatch) return null

  return {
    label: 'Google Maps pin',
    lat: Number(coordinateMatch[1]),
    lng: Number(coordinateMatch[2]),
  }
}

function extractGoogleMapsResult(rawUrl) {
  let url

  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const hostname = url.hostname.toLowerCase()
  if (!hostname.includes('google.') && hostname !== 'maps.app.goo.gl') {
    return null
  }

  if (hostname === 'maps.app.goo.gl') {
    return { needsResolve: true, url: rawUrl }
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
    const label = decodeURIComponent(pathSegments[placeIndex + 1]).replace(/\+/g, ' ')
    return {
      needsSearch: true,
      query: label,
    }
  }

  if (queryCandidates.length) {
    return {
      needsSearch: true,
      query: queryCandidates[0],
    }
  }

  return null
}

async function resolveGoogleShortUrl(url) {
  const response = await fetch(`/api/resolve-map?url=${encodeURIComponent(url)}`)
  if (!response.ok) {
    throw new Error('Unable to resolve Google Maps short link')
  }

  return response.json()
}

function buildVariants(query) {
  const normalized = normalizeQuery(query)
  if (!normalized) return []

  const variants = new Set()
  const knownAliases = QUERY_ALIASES.get(normalized) || []

  variants.add(normalized)
  knownAliases.forEach((alias) => variants.add(alias))
  variants.add(`${normalized} Japan`)
  variants.add(`${normalized} Chiba`)
  variants.add(`${normalized} Kisarazu`)

  if (/[一-龯ぁ-んァ-ン]/.test(normalized)) {
    variants.add(`${normalized} 千葉`)
    variants.add(`${normalized} 木更津`)
  }

  if (/[一-龯]/.test(normalized)) {
    variants.add(`${normalized} 日本`)
    variants.add(`${normalized} 千葉 日本`)
  }

  if (normalized.includes('ホテル')) {
    variants.add(normalized.replace(/\s*ホテル\s*/g, ' '))
  }

  return [...variants]
}

async function runNominatimSearch(query) {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(SEARCH_LIMIT),
    addressdetails: '1',
    countrycodes: 'jp',
    dedupe: '1',
  })

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'ja,en,zh-Hant,zh-Hans',
    },
  })

  if (!response.ok) {
    throw new Error('Unable to search places')
  }

  return response.json()
}

async function searchByText(query) {
  const variants = buildVariants(query)
  if (!variants.length) return []

  const seen = new Set()
  const results = []

  for (const variant of variants) {
    const payload = await runNominatimSearch(variant)

    for (const result of payload) {
      const key = `${result.lat}:${result.lon}:${result.display_name}`
      if (seen.has(key)) continue

      seen.add(key)
      results.push({
        label: result.display_name,
        lat: Number(result.lat),
        lng: Number(result.lon),
      })

      if (results.length >= SEARCH_LIMIT) {
        return results
      }
    }
  }

  return results
}

export async function searchPlaces(query) {
  const trimmed = query.trim()
  if (!trimmed) return []

  const dataPayloadResult = parseGoogleDataPayload(trimmed)
  if (dataPayloadResult) {
    return [dataPayloadResult]
  }

  const googleCandidate = extractGoogleMapsResult(trimmed)

  if (googleCandidate?.needsResolve) {
    const resolved = await resolveGoogleShortUrl(googleCandidate.url)
    if (resolved?.lat && resolved?.lng) {
      return [
        {
          label: resolved.label || 'Google Maps pin',
          lat: Number(resolved.lat),
          lng: Number(resolved.lng),
        },
      ]
    }

    if (resolved?.query) {
      return searchByText(resolved.query)
    }
  }

  if (googleCandidate?.lat && googleCandidate?.lng) {
    return [
      {
        label: googleCandidate.label || 'Google Maps pin',
        lat: googleCandidate.lat,
        lng: googleCandidate.lng,
      },
    ]
  }

  if (googleCandidate?.needsSearch) {
    return searchByText(googleCandidate.query)
  }

  return searchByText(trimmed)
}
