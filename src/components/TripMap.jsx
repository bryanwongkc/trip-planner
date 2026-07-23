import React, { memo, useEffect, useRef, useState } from 'react'
import { createMapInfoContent } from '../utils/mapInfo'
import { getItineraryItemColor } from '../utils/itemColors'
import { clusterMapMarkers, layoutMapMarkers } from '../utils/mapMarkerLayout'

const DEFAULT_MAP_CENTER = { lat: 35.6074, lng: 140.1065 }
const OVERVIEW_CLUSTER_MAX_ZOOM = 13

function getTimeRange(item) {
  if (item.generated) return 'Linked from previous day'
  if (item.endTime) return `${item.startTime} - ${item.endTime}`
  return item.startTime
}

const minimalMapStyles = [
  {
    featureType: 'administrative',
    elementType: 'geometry',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'administrative.land_parcel',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'landscape',
    elementType: 'geometry',
    stylers: [{ color: '#f8fafc' }],
  },
  {
    featureType: 'administrative.locality',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#64748b' }],
  },
  {
    featureType: 'administrative.neighborhood',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#94a3b8' }],
  },
  {
    featureType: 'landscape',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#94a3b8' }],
  },
  {
    featureType: 'landscape',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#f8fafc' }],
  },
  {
    featureType: 'poi',
    elementType: 'geometry',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'poi',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'poi',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#94a3b8' }],
  },
  {
    featureType: 'poi',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#f8fafc' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#e5e7eb' }, { weight: 0.65 }],
  },
  {
    featureType: 'road',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#94a3b8' }],
  },
  {
    featureType: 'road',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#f8fafc' }],
  },
  {
    featureType: 'transit',
    elementType: 'geometry',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'transit',
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'transit',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#94a3b8' }],
  },
  {
    featureType: 'transit',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#f8fafc' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#e0f2fe' }],
  },
  {
    featureType: 'water',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#7c8fa3' }],
  },
]

function routeColor(mode) {
  if (mode === 'walking') return '#0f766e'
  if (mode === 'transit') return '#475569'
  return '#334155'
}

function TripMap({
  fallbackLocationLabel = '',
  filteredItems,
  isOverview = false,
  routeSegments,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const overlaysRef = useRef({
    markers: [],
    clusterMarkers: [],
    polylines: [],
    leaderLines: [],
    infoWindow: null,
    viewportListener: null,
  })
  const fallbackRequestRef = useRef('')
  const [activeId, setActiveId] = useState('')
  const [fallbackLocation, setFallbackLocation] = useState(null)
  const fallbackLabel = fallbackLocationLabel.trim()
  const fallbackCenter =
    fallbackLocation?.label === fallbackLabel ? fallbackLocation.center : null

  useEffect(() => {
    if (!containerRef.current || !window.google?.maps || mapRef.current) return

    mapRef.current = new window.google.maps.Map(containerRef.current, {
      center: DEFAULT_MAP_CENTER,
      zoom: 9,
      disableDefaultUI: true,
      clickableIcons: false,
      gestureHandling: 'greedy',
      backgroundColor: '#f8fafc',
      styles: minimalMapStyles,
    })

    overlaysRef.current.infoWindow = new window.google.maps.InfoWindow()
  }, [])

  useEffect(() => {
    if (!window.google?.maps || !fallbackLabel) {
      fallbackRequestRef.current = ''
      return undefined
    }
    if (fallbackRequestRef.current === fallbackLabel) return undefined

    let active = true
    fallbackRequestRef.current = fallbackLabel
    const geocoder = new window.google.maps.Geocoder()

    geocoder.geocode({ address: fallbackLabel }, (results, status) => {
      if (!active || status !== 'OK') return
      const location = results?.[0]?.geometry?.location
      if (!location) return
      setFallbackLocation({
        label: fallbackLabel,
        center: { lat: location.lat(), lng: location.lng() },
      })
    })

    return () => {
      active = false
    }
  }, [fallbackLabel])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !window.google?.maps) return
    const overlays = overlaysRef.current

    overlays.viewportListener?.remove()
    overlays.markers.forEach((marker) => marker.setMap(null))
    overlays.clusterMarkers.forEach((marker) => marker.setMap(null))
    overlays.polylines.forEach((polyline) => polyline.setMap(null))
    overlays.leaderLines.forEach((polyline) => polyline.setMap(null))
    overlays.markers = []
    overlays.clusterMarkers = []
    overlays.polylines = []
    overlays.leaderLines = []
    overlays.viewportListener = null

    const points = filteredItems.filter(
      (item) => typeof item.lat === 'number' && typeof item.lng === 'number',
    )

    if (!points.length) {
      map.setCenter(fallbackCenter || DEFAULT_MAP_CENTER)
      map.setZoom(fallbackCenter ? 10 : 9)
      return
    }

    const bounds = new window.google.maps.LatLngBounds()
    const itemColorById = new Map(
      points.map((item, index) => [
        item.id,
        item.itineraryColor || getItineraryItemColor(index),
      ]),
    )

    points.forEach((item, index) => {
      const itemColor = itemColorById.get(item.id)
      const marker = new window.google.maps.Marker({
        map,
        position: { lat: item.lat, lng: item.lng },
        label: {
          text: String(index + 1),
          color: '#ffffff',
          fontWeight: '700',
        },
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          fillColor: itemColor.solid,
          fillOpacity: 0.95,
          strokeColor: '#ffffff',
          strokeWeight: 2.5,
          scale: 9.5,
        },
      })

      marker.addListener('click', () => setActiveId(item.id))
      marker.itineraryItemId = item.id
      overlays.markers.push(marker)
      bounds.extend({ lat: item.lat, lng: item.lng })
    })

    routeSegments
      .filter((segment) => segment.route?.path?.length)
      .forEach((segment) => {
        const polyline = new window.google.maps.Polyline({
          map,
          path: segment.route.path,
          strokeColor: itemColorById.get(segment.from.id)?.solid || routeColor(segment.mode),
          strokeOpacity: 0.58,
          strokeWeight: 2.4,
        })
        overlays.polylines.push(polyline)
      })

    const updateMarkerLayout = () => {
      overlays.clusterMarkers.forEach((marker) => marker.setMap(null))
      overlays.clusterMarkers = []
      overlays.leaderLines.forEach((polyline) => polyline.setMap(null))
      overlays.leaderLines = []

      const zoom = map.getZoom?.()
      if (isOverview && (!Number.isFinite(zoom) || zoom < OVERVIEW_CLUSTER_MAX_ZOOM)) {
        const clusters = clusterMapMarkers(points, zoom)
        const clusteredItemIndexes = new Set(
          clusters
            .filter((cluster) => cluster.itemIndexes.length > 1)
            .flatMap((cluster) => cluster.itemIndexes),
        )

        overlays.markers.forEach((marker, index) => {
          marker.setPosition({ lat: points[index].lat, lng: points[index].lng })
          marker.setMap(clusteredItemIndexes.has(index) ? null : map)
        })

        clusters
          .filter((cluster) => cluster.itemIndexes.length > 1)
          .forEach((cluster) => {
            const count = cluster.itemIndexes.length
            const clusterMarker = new window.google.maps.Marker({
              map,
              position: cluster.centerPosition,
              title: `${count} stops — click to zoom in`,
              label: {
                text: String(count),
                color: '#ffffff',
                fontSize: '12px',
                fontWeight: '800',
              },
              icon: {
                path: window.google.maps.SymbolPath.CIRCLE,
                fillColor: '#334155',
                fillOpacity: 0.96,
                strokeColor: '#ffffff',
                strokeWeight: 3,
                scale: count > 9 ? 13.5 : 12,
              },
              zIndex: 2,
            })

            clusterMarker.addListener('click', () => {
              map.setCenter(cluster.centerPosition)
              map.setZoom(
                Math.min(OVERVIEW_CLUSTER_MAX_ZOOM, (map.getZoom?.() || 9) + 2),
              )
            })
            overlays.clusterMarkers.push(clusterMarker)
          })

        overlays.infoWindow?.close()
        return
      }

      overlays.markers.forEach((marker) => marker.setMap(map))
      const layouts = layoutMapMarkers(points, zoom)
      layouts.forEach((layout, index) => {
        overlays.markers[index]?.setPosition(layout.displayPosition)

        if (!layout.spiderfied) return

        const itemColor =
          itemColorById.get(layout.item.id) || getItineraryItemColor(index)
        const leaderLine = new window.google.maps.Polyline({
          map,
          path: [layout.truePosition, layout.displayPosition],
          strokeColor: itemColor.solid,
          strokeOpacity: 0.48,
          strokeWeight: 1.35,
          clickable: false,
          zIndex: 1,
        })
        overlays.leaderLines.push(leaderLine)
      })
    }

    updateMarkerLayout()
    overlays.viewportListener = map.addListener?.('idle', updateMarkerLayout)

    if (points.length === 1) {
      map.setCenter(bounds.getCenter())
      map.setZoom(11)
    } else {
      map.fitBounds(bounds, 48)
    }

    return () => {
      overlays.viewportListener?.remove()
      overlays.viewportListener = null
      overlays.markers.forEach((marker) => marker.setMap(null))
      overlays.clusterMarkers.forEach((marker) => marker.setMap(null))
      overlays.polylines.forEach((polyline) => polyline.setMap(null))
      overlays.leaderLines.forEach((polyline) => polyline.setMap(null))
      overlays.markers = []
      overlays.clusterMarkers = []
      overlays.polylines = []
      overlays.leaderLines = []
    }
  }, [fallbackCenter, filteredItems, isOverview, routeSegments])

  useEffect(() => {
    const infoWindow = overlaysRef.current.infoWindow
    if (!infoWindow) return

    const activeItem = filteredItems.find((item) => item.id === activeId)
    const activeMarker = overlaysRef.current.markers.find(
      (marker) => marker.itineraryItemId === activeId,
    )

    if (!activeItem || !activeMarker) {
      infoWindow.close()
      return
    }

    infoWindow.setContent(createMapInfoContent(activeItem, getTimeRange(activeItem)))
    infoWindow.open({
      map: mapRef.current,
      anchor: activeMarker,
    })
  }, [activeId, filteredItems])

  return <div ref={containerRef} className="h-full w-full" />
}

export default memo(TripMap)
