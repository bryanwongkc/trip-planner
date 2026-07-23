// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TripMap from '../src/components/TripMap'

describe('TripMap itinerary colors', () => {
  let container
  let root
  let markerOptions
  let polylineOptions

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    markerOptions = []
    polylineOptions = []
    container = document.createElement('div')
    document.body.appendChild(container)

    class MockMap {
      setCenter() {}
      setZoom() {}
      fitBounds() {}
    }

    class MockMarker {
      constructor(options) {
        this.options = options
        markerOptions.push(options)
      }

      addListener() {}
      setMap() {}
      getPosition() {
        return {
          lat: () => this.options.position.lat,
          lng: () => this.options.position.lng,
        }
      }
    }

    class MockPolyline {
      constructor(options) {
        polylineOptions.push(options)
      }

      setMap() {}
    }

    class MockBounds {
      extend() {}
      getCenter() {
        return { lat: 0, lng: 0 }
      }
    }

    class MockInfoWindow {
      close() {}
      open() {}
      setContent() {}
    }

    window.google = {
      maps: {
        InfoWindow: MockInfoWindow,
        LatLngBounds: MockBounds,
        Map: MockMap,
        Marker: MockMarker,
        Polyline: MockPolyline,
        SymbolPath: { CIRCLE: 'circle' },
      },
    }
  })

  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
    delete window.google
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
  })

  it('uses each itinerary accent for its marker and outgoing route', () => {
    const firstColor = { solid: '#0f766e', soft: '#ccfbf1' }
    const secondColor = { solid: '#c2410c', soft: '#ffedd5' }

    act(() => {
      root = createRoot(container)
      root.render(
        <TripMap
          filteredItems={[
            { id: 'first', title: 'First', lat: 35, lng: 139, itineraryColor: firstColor },
            { id: 'second', title: 'Second', lat: 36, lng: 140, itineraryColor: secondColor },
          ]}
          routeSegments={[
            {
              from: { id: 'first' },
              mode: 'driving',
              route: { path: [{ lat: 35, lng: 139 }, { lat: 36, lng: 140 }] },
            },
          ]}
        />,
      )
    })

    expect(markerOptions.map((options) => options.icon.fillColor)).toEqual([
      firstColor.solid,
      secondColor.solid,
    ])
    expect(polylineOptions[0].strokeColor).toBe(firstColor.solid)
  })
})
