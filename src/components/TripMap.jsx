import React, { memo, useEffect } from 'react'
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'

function typeMeta(category) {
  if (category === 'Flight') return { fillColor: '#0ea5e9' }
  if (category === 'Car') return { fillColor: '#4f46e5' }
  if (category === 'Hotel') return { fillColor: '#f59e0b' }
  if (category === 'Wedding') return { fillColor: '#ec4899' }
  return { fillColor: '#10b981' }
}

function getTimeValue(iso) {
  return iso.slice(11, 16)
}

function FitBounds({ points }) {
  const map = useMap()

  useEffect(() => {
    if (!points.length) return
    if (points.length === 1) {
      map.setView(points[0], 11)
      return
    }
    map.fitBounds(points, { padding: [32, 32] })
  }, [map, points])

  return null
}

function TripMap({ filteredItems, movementPoints, routeSegments }) {
  return (
    <MapContainer center={[35.6074, 140.1065]} zoom={9} scrollWheelZoom={false} className="h-full w-full">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds points={movementPoints} />
      {filteredItems
        .filter((item) => typeof item.lat === 'number' && typeof item.lng === 'number')
        .map((item, index) => {
          const meta = typeMeta(item.category)

          return (
            <CircleMarker
              key={item.id}
              center={[item.lat, item.lng]}
              radius={10}
              pathOptions={{
                color: '#0f172a',
                fillColor: meta.fillColor,
                fillOpacity: 0.92,
              }}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={1}>
                {index + 1}. {item.title}
              </Tooltip>
              <Popup>
                <div className="space-y-1">
                  <div className="font-semibold">{item.title}</div>
                  <div className="text-xs text-slate-600">{item.venue}</div>
                  <div className="text-xs text-slate-600">{getTimeValue(item.startISO)}</div>
                </div>
              </Popup>
            </CircleMarker>
          )
        })}
      {routeSegments
        .filter((segment) => segment.route?.geometry?.length)
        .map((segment) => (
          <Polyline
            key={segment.id}
            positions={segment.route.geometry}
            pathOptions={{
              color: segment.mode === 'foot' ? '#0f766e' : '#2563eb',
              weight: 4,
              opacity: 0.72,
            }}
          />
        ))}
    </MapContainer>
  )
}

export default memo(TripMap)
