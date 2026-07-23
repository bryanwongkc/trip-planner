const TILE_SIZE = 256
const MAX_MERCATOR_LATITUDE = 85.05112878

export const MAP_MARKER_COLLISION_DISTANCE_PX = 28

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function projectMapPoint(position, zoom) {
  const latitude = clamp(position.lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE)
  const sinLatitude = Math.sin((latitude * Math.PI) / 180)
  const worldSize = TILE_SIZE * 2 ** zoom

  return {
    x: ((position.lng + 180) / 360) * worldSize,
    y:
      (0.5 -
        Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) *
      worldSize,
  }
}

function unprojectMapPoint(point, zoom) {
  const worldSize = TILE_SIZE * 2 ** zoom
  const longitude = (point.x / worldSize) * 360 - 180
  const mercatorY = Math.PI * (1 - (2 * point.y) / worldSize)
  const latitude = (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI

  return { lat: latitude, lng: longitude }
}

function distanceBetween(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y)
}

function collisionGroups(projectedPoints, collisionDistance) {
  const visited = new Set()
  const groups = []

  projectedPoints.forEach((point, pointIndex) => {
    if (visited.has(pointIndex)) return

    const group = []
    const queue = [pointIndex]
    visited.add(pointIndex)

    while (queue.length) {
      const currentIndex = queue.shift()
      group.push(currentIndex)

      projectedPoints.forEach((candidate, candidateIndex) => {
        if (
          visited.has(candidateIndex) ||
          distanceBetween(projectedPoints[currentIndex], candidate) >= collisionDistance
        ) {
          return
        }

        visited.add(candidateIndex)
        queue.push(candidateIndex)
      })
    }

    groups.push(group)
  })

  return groups
}

function radialOffsets(count, collisionDistance) {
  if (count === 2) {
    const radius = Math.max(19, collisionDistance * 0.68)
    return [
      { x: -radius, y: 0 },
      { x: radius, y: 0 },
    ]
  }

  const minimumSpacing = collisionDistance + 4
  const radius = Math.max(
    19,
    minimumSpacing / (2 * Math.sin(Math.PI / count)),
  )

  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    }
  })
}

export function layoutMapMarkers(
  items,
  zoom,
  collisionDistance = MAP_MARKER_COLLISION_DISTANCE_PX,
) {
  const safeZoom = Number.isFinite(zoom) ? zoom : 9
  const projectedPoints = items.map((item) =>
    projectMapPoint({ lat: item.lat, lng: item.lng }, safeZoom),
  )
  const layouts = items.map((item) => ({
    item,
    truePosition: { lat: item.lat, lng: item.lng },
    displayPosition: { lat: item.lat, lng: item.lng },
    spiderfied: false,
  }))

  collisionGroups(projectedPoints, collisionDistance).forEach((group) => {
    if (group.length < 2) return

    const center = group.reduce(
      (total, pointIndex) => ({
        x: total.x + projectedPoints[pointIndex].x / group.length,
        y: total.y + projectedPoints[pointIndex].y / group.length,
      }),
      { x: 0, y: 0 },
    )
    const offsets = radialOffsets(group.length, collisionDistance)

    group.forEach((pointIndex, groupIndex) => {
      const offset = offsets[groupIndex]
      layouts[pointIndex] = {
        ...layouts[pointIndex],
        displayPosition: unprojectMapPoint(
          { x: center.x + offset.x, y: center.y + offset.y },
          safeZoom,
        ),
        spiderfied: true,
      }
    })
  })

  return layouts
}
