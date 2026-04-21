export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' })
    return
  }

  const query = String(request.query?.q || '').trim()
  const countrycodes = String(request.query?.countrycodes || '').trim()

  if (!query) {
    response.status(400).json({ error: 'Missing q parameter' })
    return
  }

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '5',
    addressdetails: '1',
    dedupe: '1',
    'accept-language': 'ja,en,zh-Hant,zh-Hans',
  })

  if (countrycodes) {
    params.set('countrycodes', countrycodes)
  }

  try {
    const upstream = await fetch(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'trip-planner-search/1.0',
        },
      },
    )

    if (!upstream.ok) {
      response.status(upstream.status).json({ error: 'Unable to search places' })
      return
    }

    const payload = await upstream.json()
    response.status(200).json(payload)
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    })
  }
}
