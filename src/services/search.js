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
      'Accept-Language': 'ja,en',
    },
  })

  if (!response.ok) {
    throw new Error('Unable to search places')
  }

  return response.json()
}

export async function searchPlaces(query) {
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
