import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Baby,
  CarFront,
  Check,
  Cloud,
  CloudRain,
  Copy,
  ExternalLink,
  Hotel,
  Loader2,
  MapPinned,
  Navigation,
  PartyPopper,
  Plane,
  Plus,
  Search,
  ShoppingBag,
  Sparkles,
  Sun,
  X,
} from 'lucide-react'
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
import {
  STATIC_ITINERARY,
  TRAVELLER_PROFILE,
  TRIP_DATES,
} from './data/seedItinerary'
import {
  ensureAnonymousAuth,
  firebaseEnabled,
  subscribeToOverrides,
  upsertItemOverride,
} from './services/firebase'
import { fetchRoadRoute } from './services/osrm'
import { searchPlaces } from './services/search'
import { fetchWeatherSnapshot } from './services/weather'

const SAVE_DEBOUNCE_MS = 1000
const DAY_FILTERS = ['All', ...TRIP_DATES]

function getDateKey(iso) {
  return iso.slice(0, 10)
}

function getTimeValue(iso) {
  return iso.slice(11, 16)
}

function replaceTime(iso, time) {
  return `${iso.slice(0, 10)}T${time}:00+09:00`
}

function replaceDate(iso, date) {
  return `${date}T${iso.slice(11)}`
}

function formatDay(date) {
  return new Intl.DateTimeFormat('en-HK', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(`${date}T00:00:00+09:00`))
}

function typeMeta(category) {
  if (category === 'Flight') return { icon: Plane, tone: 'bg-sky-50 text-sky-600' }
  if (category === 'Car') return { icon: CarFront, tone: 'bg-indigo-50 text-indigo-600' }
  if (category === 'Hotel') return { icon: Hotel, tone: 'bg-amber-50 text-amber-600' }
  if (category === 'Wedding') return { icon: PartyPopper, tone: 'bg-pink-50 text-pink-600' }
  return { icon: ShoppingBag, tone: 'bg-emerald-50 text-emerald-600' }
}

function distanceKm(from, to) {
  const latDiff = (to.lat - from.lat) * 111
  const lngDiff = (to.lng - from.lng) * 91
  return Math.sqrt(latDiff ** 2 + lngDiff ** 2)
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

function mergeItems(overrides) {
  const staticIds = new Set(STATIC_ITINERARY.map((item) => item.id))
  const mergedStatic = STATIC_ITINERARY.map((item) => ({ ...item, ...(overrides[item.id] || {}) }))
  const userItems = Object.entries(overrides)
    .filter(([id]) => !staticIds.has(id))
    .map(([id, item]) => ({
      id,
      ...item,
    }))

  return [...mergedStatic, ...userItems].sort((a, b) => a.startISO.localeCompare(b.startISO))
}

export default function App() {
  const [activeDay, setActiveDay] = useState('All')
  const [overrides, setOverrides] = useState({})
  const [authReady, setAuthReady] = useState(false)
  const [weatherState, setWeatherState] = useState({ loading: true, data: null, error: '' })
  const [editingItem, setEditingItem] = useState(null)
  const [autosaveStatus, setAutosaveStatus] = useState(firebaseEnabled ? 'saved' : 'local')
  const [actionItem, setActionItem] = useState(null)
  const [searchState, setSearchState] = useState({ loading: false, results: [], error: '' })
  const [newItem, setNewItem] = useState({
    date: '2026-05-10',
    time: '10:00',
    category: 'Activity',
    title: '',
    venue: '',
    description: '',
    bookingRef: '',
    lat: null,
    lng: null,
    query: '',
  })

  const pressTimerRef = useRef(null)
  const movedRef = useRef(false)
  const longPressedRef = useRef(false)
  const debounceRef = useRef(null)
  const routeCacheRef = useRef(new Map())
  const [routeMap, setRouteMap] = useState({})

  const items = useMemo(() => mergeItems(overrides), [overrides])
  const filteredItems = items.filter((item) => activeDay === 'All' || getDateKey(item.startISO) === activeDay)
  const selectedWeather =
    activeDay === 'All' ? null : weatherState.data?.dailyByDate?.[activeDay] ?? null
  const firestoreReady = firebaseEnabled && authReady

  useEffect(() => {
    let unsubscribe = () => {}

    async function bootstrap() {
      if (!firebaseEnabled) {
        setAuthReady(true)
        return
      }

      try {
        await ensureAnonymousAuth()
        setAuthReady(true)
        unsubscribe = subscribeToOverrides((payload) => {
          setOverrides(payload?.items || {})
        }, console.error)
      } catch (error) {
        console.error(error)
        setAuthReady(true)
      }
    }

    bootstrap()
    return () => unsubscribe()
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchWeatherSnapshot()
      .then((data) => {
        if (!cancelled) setWeatherState({ loading: false, data, error: '' })
      })
      .catch((error) => {
        console.error(error)
        if (!cancelled) setWeatherState({ loading: false, data: null, error: 'Weather unavailable' })
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!editingItem) return
    if (!firebaseEnabled || !authReady) return

    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current)
    }

    debounceRef.current = window.setTimeout(async () => {
      try {
        await upsertItemOverride(editingItem.id, {
          title: editingItem.title,
          venue: editingItem.venue,
          description: editingItem.description,
          bookingRef: editingItem.bookingRef,
          startISO: editingItem.startISO,
          endISO: editingItem.endISO,
          category: editingItem.category,
          lat: editingItem.lat,
          lng: editingItem.lng,
        })
        setAutosaveStatus('saved')
      } catch (error) {
        console.error(error)
        setAutosaveStatus('error')
      }
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current)
      }
    }
  }, [editingItem, authReady])

  useEffect(() => {
    let cancelled = false
    const pairs = filteredItems
      .slice(0, -1)
      .map((item, index) => [item, filteredItems[index + 1]])
      .filter(([from, to]) => typeof from.lat === 'number' && typeof to.lat === 'number')

    if (!pairs.length) return

    async function loadRoutes() {
      const entries = await Promise.all(
        pairs.map(async ([from, to]) => {
          const mode = distanceKm(from, to) <= 1.5 ? 'foot' : 'driving'
          const key = `${from.id}:${to.id}:${mode}`
          const cached = routeCacheRef.current.get(key)
          if (cached) return [key, cached]

          try {
            const route = await fetchRoadRoute(from, to, mode)
            if (route) routeCacheRef.current.set(key, route)
            return [key, route]
          } catch (error) {
            console.error(error)
            return [key, null]
          }
        }),
      )

      if (!cancelled) {
        setRouteMap(Object.fromEntries(entries))
      }
    }

    loadRoutes()
    return () => {
      cancelled = true
    }
  }, [filteredItems])

  const movementPoints = filteredItems
    .filter((item) => typeof item.lat === 'number' && typeof item.lng === 'number')
    .map((item) => [item.lat, item.lng])

  const routeSegments = filteredItems.slice(0, -1).map((item, index) => {
    const next = filteredItems[index + 1]
    const mode = distanceKm(item, next) <= 1.5 ? 'foot' : 'driving'
    const key = `${item.id}:${next.id}:${mode}`
    const route = routeMap[key]
    const bufferMinutes =
      (new Date(next.startISO).getTime() - new Date(item.endISO).getTime()) / 60000 -
      (route?.durationMin ?? 0)

    return { id: key, from: item, to: next, route, bufferMinutes, mode }
  })

  function openEditor(item) {
    if (!firestoreReady) {
      return
    }

    setAutosaveStatus('saved')
    setEditingItem({ ...item })
  }

  function updateEditing(changes) {
    if (!firestoreReady) {
      return
    }

    setAutosaveStatus('saving')
    setEditingItem((current) => {
      if (!current) return current
      const next = { ...current, ...changes }
      setOverrides((existing) => ({
        ...existing,
        [current.id]: {
          ...(existing[current.id] || {}),
          ...next,
        },
      }))
      return next
    })
  }

  function beginPress(item) {
    movedRef.current = false
    longPressedRef.current = false
    pressTimerRef.current = window.setTimeout(() => {
      if (!movedRef.current) {
        longPressedRef.current = true
        navigator.vibrate?.(50)
        setActionItem(item)
      }
    }, 600)
  }

  function endPress(item) {
    if (pressTimerRef.current) {
      window.clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }

    if (!movedRef.current && !longPressedRef.current) {
      openEditor(item)
    }
  }

  async function runSearch() {
    try {
      setSearchState({ loading: true, results: [], error: '' })
      const results = await searchPlaces(newItem.query)
      setSearchState({ loading: false, results, error: '' })
    } catch (error) {
      console.error(error)
      setSearchState({ loading: false, results: [], error: 'Search failed' })
    }
  }

  async function saveNewItem() {
    if (!firestoreReady) {
      return
    }

    const id = `user-${Date.now()}`
    const startISO = `${newItem.date}T${newItem.time}:00+09:00`
    const payload = {
      id,
      title: newItem.title || 'New plan item',
      venue: newItem.venue || 'Location TBD',
      category: newItem.category,
      startISO,
      endISO: startISO,
      description: newItem.description,
      bookingRef: newItem.bookingRef,
      lat: newItem.lat,
      lng: newItem.lng,
    }

    await upsertItemOverride(id, payload)

    setNewItem({
      date: newItem.date,
      time: '10:00',
      category: 'Activity',
      title: '',
      venue: '',
      description: '',
      bookingRef: '',
      lat: null,
      lng: null,
      query: '',
    })
    setSearchState({ loading: false, results: [], error: '' })
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-5 text-slate-900 sm:px-6 lg:px-8">
      <section className="glass-panel rounded-[2rem] border border-white/60 px-5 py-5 sm:px-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-indigo-700">
              <Sparkles className="h-3.5 w-3.5" />
              Fresh rebuild
            </div>
            <h1 className="headline mt-3 text-3xl leading-tight sm:text-5xl">Interactive trip planner</h1>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-700">
              Plan the May 9-13 family trip, visualize movements on the map, keep notes synced, and keep adding details as they come in.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <StatCard icon={Baby} label="Travellers" value={TRAVELLER_PROFILE.party.join(' · ')} />
            <StatCard
              icon={selectedWeather?.rainProbability >= 40 ? CloudRain : Sun}
              label="Selected day weather"
              value={
                activeDay === 'All'
                  ? 'Pick a day'
                  : weatherState.loading
                    ? 'Loading'
                    : selectedWeather
                      ? `${Math.round(selectedWeather.tempMax)}° / rain ${selectedWeather.rainProbability ?? 0}%`
                      : weatherState.error
              }
            />
            <StatCard
              icon={Cloud}
              label="Firestore sync"
              value={firestoreReady ? 'Ready for save' : firebaseEnabled ? 'Connecting…' : 'Firebase required'}
            />
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="space-y-4">
          <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Planner</p>
                <h2 className="headline mt-2 text-3xl text-slate-900">
                  {activeDay === 'All' ? 'Full itinerary' : formatDay(activeDay)}
                </h2>
              </div>
              <div className="flex gap-2">
                <TabButton active>Planner</TabButton>
              </div>
            </div>

            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              {DAY_FILTERS.map((day) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => setActiveDay(day)}
                  className={`min-w-[108px] rounded-2xl px-4 py-3 text-left text-sm font-semibold transition ${
                    activeDay === day ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'
                  }`}
                >
                  {day === 'All' ? 'Overview' : day.slice(5).replace('-', '/')}
                </button>
              ))}
            </div>
          </div>

          <>
              <div className="space-y-4">
                {filteredItems.map((item, index) => {
                  const meta = typeMeta(item.category)
                  const nextSegment = routeSegments[index]

                  return (
                    <div key={item.id} className="space-y-3">
                      <article
                        className="glass-panel rounded-[1.6rem] border border-white/60 p-4 transition active:bg-white/90"
                        onMouseDown={() => beginPress(item)}
                        onMouseUp={() => endPress(item)}
                        onMouseLeave={() => endPress(item)}
                        onTouchStart={() => beginPress(item)}
                        onTouchEnd={() => endPress(item)}
                        onTouchMove={() => {
                          movedRef.current = true
                        }}
                        onContextMenu={(event) => event.preventDefault()}
                      >
                        <div className="flex items-start gap-4">
                          <div className={`rounded-2xl p-3 ${meta.tone}`}>
                            <meta.icon className="h-5 w-5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-indigo-600">
                                {getTimeValue(item.startISO)}
                              </span>
                              <div className="flex items-center gap-2 text-slate-300">
                                <MapPinned className="h-4 w-4" />
                                <Search className="h-4 w-4" />
                              </div>
                            </div>
                            <h3 className="mt-1 text-lg font-bold text-slate-900">{item.title}</h3>
                            <p className="mt-1 text-sm text-slate-600">{item.venue}</p>
                            <p className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-500">
                              {item.description || 'Tap to add notes, booking refs, or toddler reminders.'}
                            </p>
                          </div>
                        </div>
                      </article>

                      {nextSegment ? (
                        <div className="rounded-[1.25rem] bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                          {nextSegment.route
                            ? `${nextSegment.mode === 'foot' ? 'Walk' : 'Drive'} ${Math.round(nextSegment.route.durationMin)} min · toddler buffer ${Math.round(nextSegment.bufferMinutes)} min`
                            : 'Fetching route'}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Add detail</p>
                    <h3 className="headline mt-2 text-2xl text-slate-900">New stop or note</h3>
                  </div>
                  <div className="rounded-2xl bg-slate-900 p-3 text-white">
                    <Plus className="h-5 w-5" />
                  </div>
                </div>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Field label="Date">
                    <select
                      value={newItem.date}
                      onChange={(event) => setNewItem((current) => ({ ...current, date: event.target.value }))}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    >
                      {TRIP_DATES.map((date) => (
                        <option key={date} value={date}>
                          {formatDay(date)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Time">
                    <input
                      type="time"
                      value={newItem.time}
                      onChange={(event) => setNewItem((current) => ({ ...current, time: event.target.value }))}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    />
                  </Field>
                  <Field label="Category">
                    <select
                      value={newItem.category}
                      onChange={(event) => setNewItem((current) => ({ ...current, category: event.target.value }))}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    >
                      {['Activity', 'Flight', 'Car', 'Hotel', 'Wedding', 'Shopping'].map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Title">
                    <input
                      value={newItem.title}
                      onChange={(event) => setNewItem((current) => ({ ...current, title: event.target.value }))}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    />
                  </Field>
                </div>

                <div className="mt-4 space-y-3">
                  <Field label="Search location">
                    <div className="flex gap-2">
                      <input
                        value={newItem.query}
                        onChange={(event) => setNewItem((current) => ({ ...current, query: event.target.value }))}
                        placeholder="Search with OpenStreetMap"
                        className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => void runSearch()}
                        className="rounded-2xl bg-slate-900 px-4 text-white"
                      >
                        {searchState.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      </button>
                    </div>
                  </Field>

                  {searchState.results.length ? (
                    <div className="space-y-2 rounded-2xl bg-slate-50 p-3">
                      {searchState.results.map((result) => (
                        <button
                          key={`${result.lat}-${result.lng}`}
                          type="button"
                          onClick={() => {
                            setNewItem((current) => ({
                              ...current,
                              venue: result.label,
                              query: result.label,
                              lat: result.lat,
                              lng: result.lng,
                            }))
                            setSearchState({ loading: false, results: [], error: '' })
                          }}
                          className="block w-full rounded-2xl bg-white px-4 py-3 text-left text-sm text-slate-700"
                        >
                          {result.label}
                        </button>
                      ))}
                    </div>
                  ) : null}

                  <Field label="Venue">
                    <input
                      value={newItem.venue}
                      onChange={(event) => setNewItem((current) => ({ ...current, venue: event.target.value }))}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    />
                  </Field>
                  <Field label="Description / notes">
                    <textarea
                      rows={4}
                      value={newItem.description}
                      onChange={(event) => setNewItem((current) => ({ ...current, description: event.target.value }))}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    />
                  </Field>
                  <Field label="Booking ref">
                    <input
                      value={newItem.bookingRef}
                      onChange={(event) => setNewItem((current) => ({ ...current, bookingRef: event.target.value }))}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                    />
                  </Field>
                </div>

                <button
                  type="button"
                  onClick={() => void saveNewItem()}
                  disabled={!firestoreReady}
                  title={!firestoreReady ? 'Wait for Firestore connection before saving' : undefined}
                  className="mt-4 w-full rounded-[1.4rem] bg-indigo-600 px-4 py-4 text-sm font-bold text-white shadow-lg shadow-indigo-100"
                >
                  {firestoreReady ? 'Save new itinerary detail' : 'Waiting for Firestore'}
                </button>
              </div>
            </>
        </div>

        <div className="space-y-4">
          <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Movement view</p>
                <h2 className="headline mt-2 text-3xl text-slate-900">Interactive map</h2>
              </div>
              <div className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white">
                {activeDay === 'All' ? 'Whole trip' : formatDay(activeDay)}
              </div>
            </div>

            <div className="mt-4 h-[420px] overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-100">
              <MapContainer center={[35.6074, 140.1065]} zoom={9} scrollWheelZoom={false}>
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <FitBounds points={movementPoints} />
                {filteredItems.map((item, index) => {
                  const meta = typeMeta(item.category)

                  return (
                    <CircleMarker
                      key={item.id}
                      center={[item.lat, item.lng]}
                      radius={10}
                      pathOptions={{
                        color: '#0f172a',
                        fillColor: meta.tone.includes('pink') ? '#ec4899' : meta.tone.includes('amber') ? '#f59e0b' : '#4f46e5',
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
            </div>
          </div>

          <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Trip logic</p>
                <h3 className="headline mt-2 text-2xl text-slate-900">Buffers and notes</h3>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {routeSegments.map((segment) => (
                <div key={segment.id} className="rounded-2xl bg-white p-4 shadow-sm">
                  <div className="text-sm font-semibold text-slate-900">
                    {segment.from.title} → {segment.to.title}
                  </div>
                  <div className="mt-1 text-sm text-slate-600">
                    {segment.route
                      ? `${segment.mode === 'foot' ? 'Walk' : 'Drive'} ${Math.round(segment.route.durationMin)} min · ${segment.route.distanceKm.toFixed(1)} km`
                      : 'Route loading'}
                  </div>
                  <div className="mt-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Toddler buffer: {Math.round(segment.bufferMinutes)} min
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {editingItem ? (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
          <div className="glass-panel w-full max-w-xl rounded-[2rem] border border-white/60 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Item editor</p>
                <h3 className="mt-2 text-2xl font-bold text-slate-900">{editingItem.title}</h3>
                <div className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {autosaveStatus === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {autosaveStatus === 'saving' ? 'Autosaving…' : 'All changes synced'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="rounded-full bg-slate-100 p-2 text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <Field label="Title">
                <input
                  value={editingItem.title}
                  onChange={(event) => updateEditing({ title: event.target.value })}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Venue">
                <input
                  value={editingItem.venue || ''}
                  onChange={(event) => updateEditing({ venue: event.target.value })}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Date">
                <input
                  type="date"
                  value={getDateKey(editingItem.startISO)}
                  onChange={(event) =>
                    updateEditing({
                      startISO: replaceDate(editingItem.startISO, event.target.value),
                      endISO: replaceDate(editingItem.endISO, event.target.value),
                    })
                  }
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Start time">
                <input
                  type="time"
                  value={getTimeValue(editingItem.startISO)}
                  onChange={(event) => updateEditing({ startISO: replaceTime(editingItem.startISO, event.target.value) })}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Booking ref">
                <input
                  value={editingItem.bookingRef || ''}
                  onChange={(event) => updateEditing({ bookingRef: event.target.value })}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Category">
                <input
                  value={editingItem.category}
                  onChange={(event) => updateEditing({ category: event.target.value })}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
            </div>

            <Field label="Notes" className="mt-4">
              <textarea
                rows={5}
                value={editingItem.description || ''}
                onChange={(event) => updateEditing({ description: event.target.value })}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
              />
            </Field>
          </div>
        </div>
      ) : null}

      {actionItem ? (
        <div
          className="fixed inset-0 z-40 flex items-end bg-slate-950/45 p-4 backdrop-blur-sm"
          onClick={() => setActionItem(null)}
        >
          <div
            className="glass-panel w-full max-w-lg rounded-[2rem] border border-white/60 p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-3 p-3">
              <div className="rounded-2xl bg-indigo-50 p-3 text-indigo-600">
                <Navigation className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Navigator</p>
                <div className="font-semibold text-slate-900">{actionItem.title}</div>
              </div>
            </div>
            <div className="space-y-2">
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${actionItem.lat},${actionItem.lng}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-2xl bg-indigo-600 px-4 py-4 text-sm font-bold text-white"
              >
                Open in Google Maps
                <ExternalLink className="h-4 w-4" />
              </a>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(`${actionItem.lat}, ${actionItem.lng}`)}
                className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-4 text-sm font-bold text-slate-900"
              >
                Copy coordinates
                <Copy className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setActionItem(null)
                  openEditor(actionItem)
                }}
                className="flex w-full items-center justify-between rounded-2xl bg-slate-100 px-4 py-4 text-sm font-bold text-slate-900"
              >
                Edit details
                <MapPinned className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function StatCard({ icon, label, value }) {
  return (
    <div className="rounded-2xl bg-white/80 px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {React.createElement(icon, { className: 'h-4 w-4' })}
        {label}
      </div>
      <div className="mt-2 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  )
}

function TabButton({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-semibold ${
        active ? 'bg-slate-900 text-white' : 'bg-white text-slate-500'
      }`}
    >
      {children}
    </button>
  )
}

function Field({ label, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  )
}
