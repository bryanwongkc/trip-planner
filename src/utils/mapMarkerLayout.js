const TILE_SIZE = 256
const MAX_MERCATOR_LATITUDE = 85.05112878

export const MAP_MARKER_COLLISION_DISTANCE_PX = 28
export const MAP_MARKER_TOUCH_DISTANCE_PX = 21.5
export const MAP_OVERVIEW_CLUSTER_DISTANCE_PX = 48

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

export function clusterMapMarkers(
  items,
  zoom,
  clusterDistance = MAP_OVERVIEW_CLUSTER_DISTANCE_PX,
) {
  const safeZoom = Number.isFinite(zoom) ? zoom : 9
  const groups = []

  items.forEach((item, itemIndex) => {
    const point = projectMapPoint({ lat: item.lat, lng: item.lng }, safeZoom)
    let closestGroup = null
    let closestDistance = clusterDistance

    groups.forEach((group) => {
      const distance = distanceBetween(point, group.centerPoint)
      if (distance >= closestDistance) return
      closestGroup = group
      closestDistance = distance
    })

    if (!closestGroup) {
      groups.push({
        itemIndexes: [itemIndex],
        centerPoint: point,
      })
      return
    }

    closestGroup.itemIndexes.push(itemIndex)
    const itemCount = closestGroup.itemIndexes.length
    closestGroup.centerPoint = {
      x: closestGroup.centerPoint.x + (point.x - closestGroup.centerPoint.x) / itemCount,
      y: closestGroup.centerPoint.y + (point.y - closestGroup.centerPoint.y) / itemCount,
    }
  })

  return groups.map((group) => ({
    itemIndexes: group.itemIndexes,
    items: group.itemIndexes.map((itemIndex) => items[itemIndex]),
    centerPosition: unprojectMapPoint(group.centerPoint, safeZoom),
  }))
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

function radialOffsets(count) {
  if (count === 2) {
    const radius = MAP_MARKER_TOUCH_DISTANCE_PX / 2
    return [
      { x: -radius, y: 0 },
      { x: radius, y: 0 },
    ]
  }

  const radius =
    MAP_MARKER_TOUCH_DISTANCE_PX / (2 * Math.sin(Math.PI / count))

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
    const offsets = radialOffsets(group.length)

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
