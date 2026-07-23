// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import TripMap from '../src/components/TripMap'

describe('TripMap itinerary colors', () => {
  let container
  let root
  let markerOptions
  let markerInstances
  let polylineOptions

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    markerOptions = []
    markerInstances = []
    polylineOptions = []
    container = document.createElement('div')
    document.body.appendChild(container)

    class MockMap {
      setCenter() {}
      setZoom() {}
      fitBounds() {}
      getZoom() {
        return 12
      }
      addListener() {
        return { remove() {} }
      }
    }

    class MockMarker {
      constructor(options) {
        this.options = options
        this.map = options.map
        this.listeners = {}
        markerOptions.push(options)
        markerInstances.push(this)
      }

      addListener(eventName, listener) {
        this.listeners[eventName] = listener
      }
      setMap(map) {
        this.map = map
      }
      setPosition(position) {
        this.options.position = position
      }
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

  it('fans out colliding markers and connects them to their exact locations', () => {
    const firstColor = { solid: '#0f766e', soft: '#ccfbf1' }
    const secondColor = { solid: '#7e22ce', soft: '#f3e8ff' }
    const sharedPosition = { lat: 35.6074, lng: 140.1065 }

    act(() => {
      root = createRoot(container)
      root.render(
        <TripMap
          filteredItems={[
            { id: 'first', title: 'First', ...sharedPosition, itineraryColor: firstColor },
            { id: 'second', title: 'Second', ...sharedPosition, itineraryColor: secondColor },
          ]}
          routeSegments={[]}
        />,
      )
    })

    expect(markerOptions[0].position).not.toEqual(markerOptions[1].position)
    expect(polylineOptions).toHaveLength(2)
    expect(polylineOptions.map((options) => options.strokeColor)).toEqual([
      firstColor.solid,
      secondColor.solid,
    ])
    expect(polylineOptions.map((options) => options.path[0])).toEqual([
      sharedPosition,
      sharedPosition,
    ])
    expect(polylineOptions.map((options) => options.path[1])).toEqual(
      markerOptions.map((options) => options.position),
    )
  })

  it('uses a single zoomable count marker for dense overview stops', () => {
    act(() => {
      root = createRoot(container)
      root.render(
        <TripMap
          filteredItems={[
            { id: 'first', title: 'First', lat: 35.6074, lng: 140.1065 },
            { id: 'second', title: 'Second', lat: 35.6074, lng: 140.1065 },
            { id: 'third', title: 'Third', lat: 35.6074, lng: 140.1065 },
          ]}
          isOverview
          routeSegments={[]}
        />,
      )
    })

    expect(markerOptions).toHaveLength(4)
    expect(markerOptions[3].label.text).toBe('3')
    expect(markerOptions[3].title).toBe('3 stops — click to zoom in')
    expect(markerInstances.slice(0, 3).every((marker) => marker.map === null)).toBe(true)
    expect(polylineOptions).toHaveLength(0)
  })
})
