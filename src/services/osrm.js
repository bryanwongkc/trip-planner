export async function fetchRoadRoute(from, to) {
  if (
    typeof from?.lat !== 'number' ||
    typeof from?.lng !== 'number' ||
    typeof to?.lat !== 'number' ||
    typeof to?.lng !== 'number'
  ) {
    return null
  }

  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
  })

  const response = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${coordinates}?${params.toString()}`,
  )

  if (!response.ok) {
    throw new Error('Unable to fetch driving route')
  }

  const payload = await response.json()
  const [route] = payload.routes || []

  if (!route) {
    return null
  }

  return {
    distanceKm: route.distance / 1000,
    durationMin: route.duration / 60,
    geometry: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
  }
}
