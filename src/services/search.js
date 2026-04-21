export async function searchPlaces(query) {
  const trimmed = query.trim()

  if (!trimmed) {
    return []
  }

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    limit: '5',
    addressdetails: '1',
  })

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error('Unable to search places')
  }

  const payload = await response.json()

  return payload.map((result) => ({
    label: result.display_name,
    lat: Number(result.lat),
    lng: Number(result.lon),
  }))
}
