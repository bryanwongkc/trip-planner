import { describe, expect, it } from 'vitest'
import {
  layoutMapMarkers,
  MAP_MARKER_TOUCH_DISTANCE_PX,
  projectMapPoint,
} from '../src/utils/mapMarkerLayout'

describe('layoutMapMarkers', () => {
  it('keeps separated markers at their exact coordinates', () => {
    const items = [
      { id: 'first', lat: 35, lng: 139 },
      { id: 'second', lat: 36, lng: 140 },
    ]

    const layouts = layoutMapMarkers(items, 12)

    expect(layouts.map((layout) => layout.displayPosition)).toEqual([
      { lat: 35, lng: 139 },
      { lat: 36, lng: 140 },
    ])
    expect(layouts.every((layout) => !layout.spiderfied)).toBe(true)
  })

  it('places colliding markers edge-to-edge without a visible gap', () => {
    const items = [
      { id: 'first', lat: 35.6074, lng: 140.1065 },
      { id: 'second', lat: 35.6074, lng: 140.1065 },
      { id: 'third', lat: 35.6074, lng: 140.1065 },
    ]

    const layouts = layoutMapMarkers(items, 12)
    const displayPoints = layouts.map((layout) =>
      projectMapPoint(layout.displayPosition, 12),
    )

    expect(layouts.every((layout) => layout.spiderfied)).toBe(true)
    displayPoints.forEach((point, index) => {
      displayPoints.slice(index + 1).forEach((otherPoint) => {
        expect(Math.hypot(point.x - otherPoint.x, point.y - otherPoint.y)).toBeCloseTo(
          MAP_MARKER_TOUCH_DISTANCE_PX,
          5,
        )
      })
    })
  })

  it('returns the same radial layout for the same itinerary order', () => {
    const items = [
      { id: 'first', lat: 35.6074, lng: 140.1065 },
      { id: 'second', lat: 35.6074, lng: 140.1065 },
    ]

    expect(layoutMapMarkers(items, 12)).toEqual(layoutMapMarkers(items, 12))
  })
})
