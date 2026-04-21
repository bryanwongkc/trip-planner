import React, {
  Suspense,
  lazy,
  memo,
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  CarFront,
  Check,
  Cloud,
  CloudRain,
  Copy,
  ExternalLink,
  Hotel,
  Laptop,
  Loader2,
  MapPinned,
  Navigation,
  PartyPopper,
  Plane,
  Plus,
  Search,
  ShoppingBag,
  Smartphone,
  Sparkles,
  Sun,
  X,
} from 'lucide-react'
import { STATIC_ITINERARY, TRAVELLER_PROFILE, TRIP_DATES } from './data/seedItinerary'
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
const LONG_PRESS_MS = 600
const MOVE_THRESHOLD = 10
const DAY_FILTERS = ['All', ...TRIP_DATES]
const VIEW_MODES = [
  { id: 'desktop', label: 'Desktop', icon: Laptop },
  { id: 'mobile', label: 'Mobile portrait', icon: Smartphone },
]
const TripMap = lazy(() => import('./components/TripMap'))

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

function routeLabel(mode) {
  return mode === 'foot' ? 'Walk' : 'Drive'
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

function getRoutePairs(items) {
  return items
    .slice(0, -1)
    .map((item, index) => [item, items[index + 1]])
    .filter(([from, to]) => typeof from.lat === 'number' && typeof to.lat === 'number')
}

export default function App() {
  const [activeDay, setActiveDay] = useState('All')
  const [viewMode, setViewMode] = useState('desktop')
  const [overrides, setOverrides] = useState({})
  const [authReady, setAuthReady] = useState(false)
  const [weatherState, setWeatherState] = useState({ loading: true, data: null, error: '' })
  const [editingItem, setEditingItem] = useState(null)
  const [autosaveStatus, setAutosaveStatus] = useState(firebaseEnabled ? 'saved' : 'offline')
  const [actionItem, setActionItem] = useState(null)
  const [routeMap, setRouteMap] = useState({})

  const debounceRef = useRef(null)
  const routeCacheRef = useRef(new Map())
  const pressStateRef = useRef({
    timer: null,
    pointerId: null,
    itemId: null,
    startX: 0,
    startY: 0,
    moved: false,
    longPressed: false,
  })

  const items = useMemo(() => mergeItems(overrides), [overrides])
  const filteredItems = useMemo(
    () => items.filter((item) => activeDay === 'All' || getDateKey(item.startISO) === activeDay),
    [activeDay, items],
  )
  const deferredItems = useDeferredValue(filteredItems)
  const selectedWeather =
    activeDay === 'All' ? null : weatherState.data?.dailyByDate?.[activeDay] ?? null
  const firestoreReady = firebaseEnabled && authReady

  useEffect(() => {
    let active = true
    let unsubscribe = () => {}

    async function bootstrap() {
      if (!firebaseEnabled) {
        if (active) setAuthReady(true)
        return
      }

      try {
        await ensureAnonymousAuth()
        if (!active) return

        setAuthReady(true)
        unsubscribe = await subscribeToOverrides((payload) => {
          setOverrides(payload?.items || {})
        }, console.error)
      } catch (error) {
        console.error(error)
        if (active) setAuthReady(true)
      }
    }

    void bootstrap()
    return () => {
      active = false
      unsubscribe()
    }
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
    if (!editingItem || !firebaseEnabled || !authReady) return

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

  const routePairs = useMemo(() => getRoutePairs(deferredItems), [deferredItems])

  useEffect(() => {
    let cancelled = false

    if (!routePairs.length) return

    async function loadRoutes() {
      const entries = await Promise.all(
        routePairs.map(async ([from, to]) => {
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
        setRouteMap((current) => ({ ...current, ...Object.fromEntries(entries) }))
      }
    }

    void loadRoutes()
    return () => {
      cancelled = true
    }
  }, [routePairs])

  const movementPoints = useMemo(
    () =>
      deferredItems
        .filter((item) => typeof item.lat === 'number' && typeof item.lng === 'number')
        .map((item) => [item.lat, item.lng]),
    [deferredItems],
  )

  const routeSegments = useMemo(
    () =>
      deferredItems.slice(0, -1).map((item, index) => {
        const next = deferredItems[index + 1]
        const mode = distanceKm(item, next) <= 1.5 ? 'foot' : 'driving'
        const key = `${item.id}:${next.id}:${mode}`

        return { id: key, from: item, to: next, route: routeMap[key], mode }
      }),
    [deferredItems, routeMap],
  )

  function openEditor(item) {
    if (!firestoreReady) return
    setAutosaveStatus('saved')
    setEditingItem({ ...item })
  }

  function updateEditing(changes) {
    if (!firestoreReady) return
    setAutosaveStatus('saving')
    setEditingItem((current) => (current ? { ...current, ...changes } : current))
  }

  function clearPressState() {
    const state = pressStateRef.current
    if (state.timer) {
      window.clearTimeout(state.timer)
    }
    pressStateRef.current = {
      timer: null,
      pointerId: null,
      itemId: null,
      startX: 0,
      startY: 0,
      moved: false,
      longPressed: false,
    }
  }

  function handlePointerDown(event, item) {
    if (event.pointerType === 'mouse' && event.button !== 0) return

    clearPressState()
    pressStateRef.current = {
      timer: window.setTimeout(() => {
        const state = pressStateRef.current
        if (!state.moved && state.itemId === item.id) {
          pressStateRef.current.longPressed = true
          navigator.vibrate?.(50)
          setActionItem(item)
        }
      }, LONG_PRESS_MS),
      pointerId: event.pointerId,
      itemId: item.id,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      longPressed: false,
    }
  }

  function handlePointerMove(event) {
    const state = pressStateRef.current
    if (state.pointerId !== event.pointerId) return

    const movedX = Math.abs(event.clientX - state.startX)
    const movedY = Math.abs(event.clientY - state.startY)
    if (movedX > MOVE_THRESHOLD || movedY > MOVE_THRESHOLD) {
      pressStateRef.current.moved = true
      if (state.timer) {
        window.clearTimeout(state.timer)
        pressStateRef.current.timer = null
      }
    }
  }

  function handlePointerEnd(event, item) {
    const state = pressStateRef.current
    if (state.pointerId !== event.pointerId) return

    const shouldOpenEditor = !state.moved && !state.longPressed && state.itemId === item.id
    clearPressState()
    if (shouldOpenEditor) {
      openEditor(item)
    }
  }

  const plannerPanel = (
    <PlannerPanel
      activeDay={activeDay}
      filteredItems={filteredItems}
      firestoreReady={firestoreReady}
      routeSegments={routeSegments}
      onDayChange={(day) => {
        startTransition(() => {
          setActiveDay(day)
        })
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerEnd={handlePointerEnd}
      onPointerCancel={clearPressState}
      onSaveNewItem={upsertItemOverride}
      selectedWeather={selectedWeather}
      weatherState={weatherState}
    />
  )

  const mapPanel = (
    <MemoMapPanel
      activeDay={activeDay}
      filteredItems={deferredItems}
      movementPoints={movementPoints}
      routeSegments={routeSegments}
      viewMode={viewMode}
    />
  )

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-5 text-slate-900 sm:px-6 lg:px-8">
      <section className="glass-panel rounded-[2rem] border border-white/60 px-5 py-5 sm:px-7">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-indigo-700">
              <Sparkles className="h-3.5 w-3.5" />
              Trip control
            </div>
            <h1 className="headline mt-3 text-3xl leading-tight sm:text-5xl">Interactive trip planner</h1>
            <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-700">
              Plan the May 9-13 family trip, review movement on the map, and keep every itinerary detail synced to Firestore.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:min-w-[27rem]">
            <StatCard icon={Cloud} label="Firestore sync" value={firestoreReady ? 'Ready for save' : 'Connecting'} />
            <StatCard icon={Plane} label="Travellers" value={TRAVELLER_PROFILE.party.join(' · ')} />
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-white/60 pt-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">View mode</p>
            <h2 className="headline mt-2 text-2xl text-slate-900">Toggle desktop or mobile portrait</h2>
          </div>

          <div className="inline-flex rounded-[1.25rem] bg-slate-100 p-1.5">
            {VIEW_MODES.map((mode) => {
              const Icon = mode.icon
              return (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => {
                    startTransition(() => {
                      setViewMode(mode.id)
                    })
                  }}
                  className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
                    viewMode === mode.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {mode.label}
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {viewMode === 'desktop' ? (
        <section className="mt-6 grid gap-6 lg:grid-cols-[1.06fr_0.94fr]">
          <div className="space-y-4">{plannerPanel}</div>
          <div className="space-y-4">{mapPanel}</div>
        </section>
      ) : (
        <section className="mt-6 mx-auto max-w-md space-y-4">
          {plannerPanel}
          {mapPanel}
        </section>
      )}

      {editingItem ? (
        <EditModal
          autosaveStatus={autosaveStatus}
          editingItem={editingItem}
          onChange={updateEditing}
          onClose={() => setEditingItem(null)}
        />
      ) : null}

      {actionItem ? (
        <ActionSheet
          actionItem={actionItem}
          onClose={() => setActionItem(null)}
          onEdit={() => {
            const item = actionItem
            setActionItem(null)
            openEditor(item)
          }}
        />
      ) : null}
    </main>
  )
}

function PlannerPanel({
  activeDay,
  filteredItems,
  firestoreReady,
  routeSegments,
  onDayChange,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onPointerCancel,
  onSaveNewItem,
  selectedWeather,
  weatherState,
}) {
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
    if (!firestoreReady) return

    const id = `user-${Date.now()}`
    const startISO = `${newItem.date}T${newItem.time}:00+09:00`

    await onSaveNewItem(id, {
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
    })

    setNewItem((current) => ({
      ...current,
      time: '10:00',
      title: '',
      venue: '',
      description: '',
      bookingRef: '',
      lat: null,
      lng: null,
      query: '',
    }))
    setSearchState({ loading: false, results: [], error: '' })
  }

  return (
    <>
      <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Planner</p>
            <h2 className="headline mt-2 text-3xl text-slate-900">
              {activeDay === 'All' ? 'Full itinerary' : formatDay(activeDay)}
            </h2>
          </div>
          <div className="rounded-full bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Tap to edit · Hold to navigate
          </div>
        </div>

        <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
          {DAY_FILTERS.map((day) => (
            <button
              key={day}
              type="button"
              onClick={() => onDayChange(day)}
              className={`min-w-[108px] rounded-2xl px-4 py-3 text-left text-sm font-semibold transition ${
                activeDay === day ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'
              }`}
            >
              {day === 'All' ? 'Overview' : day.slice(5).replace('-', '/')}
            </button>
          ))}
        </div>

        {activeDay !== 'All' ? (
          <div className="mt-4 rounded-[1.4rem] bg-white px-4 py-4 shadow-sm">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Weather snapshot</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-lg font-bold text-slate-900">
                  {weatherState.loading
                    ? 'Loading weather'
                    : selectedWeather
                      ? `${Math.round(selectedWeather.tempMax)}° · Rain ${selectedWeather.rainProbability ?? 0}%`
                      : weatherState.error}
                </div>
                <div className="mt-1 text-sm text-slate-600">
                  {selectedWeather?.label || 'Weather is only shown in individual day view.'}
                </div>
              </div>
              <div className="rounded-2xl bg-slate-100 p-3 text-slate-700">
                {selectedWeather?.rainProbability >= 40 ? (
                  <CloudRain className="h-5 w-5" />
                ) : selectedWeather ? (
                  <Sun className="h-5 w-5" />
                ) : (
                  <Cloud className="h-5 w-5" />
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-4">
        {filteredItems.map((item, index) => {
          const meta = typeMeta(item.category)
          const nextSegment = routeSegments[index]

          return (
            <div key={item.id} className="space-y-3">
              <article
                className="glass-panel rounded-[1.6rem] border border-white/60 p-4 transition hover:bg-white/85 active:bg-white/90"
                onPointerDown={(event) => onPointerDown(event, item)}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => onPointerEnd(event, item)}
                onPointerCancel={onPointerCancel}
                onPointerLeave={onPointerCancel}
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
                      {item.description || 'Tap to add notes and booking refs.'}
                    </p>
                  </div>
                </div>
              </article>

              {nextSegment ? (
                <div className="rounded-[1.25rem] bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                  {nextSegment.route
                    ? `${routeLabel(nextSegment.mode)} ${Math.round(nextSegment.route.durationMin)} min · ${nextSegment.route.distanceKm.toFixed(1)} km to ${nextSegment.to.title}`
                    : `Fetching route to ${nextSegment.to.title}`}
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
  )
}

function EditModal({ autosaveStatus, editingItem, onChange, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <div className="glass-panel w-full max-w-xl rounded-[2rem] border border-white/60 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Item editor</p>
            <h3 className="mt-2 text-2xl font-bold text-slate-900">{editingItem.title}</h3>
            <div className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {autosaveStatus === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {autosaveStatus === 'saving'
                ? 'Autosaving...'
                : autosaveStatus === 'error'
                  ? 'Save failed'
                  : 'All changes synced'}
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Title">
            <input
              value={editingItem.title}
              onChange={(event) => onChange({ title: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Venue">
            <input
              value={editingItem.venue || ''}
              onChange={(event) => onChange({ venue: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={getDateKey(editingItem.startISO)}
              onChange={(event) =>
                onChange({
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
              onChange={(event) => onChange({ startISO: replaceTime(editingItem.startISO, event.target.value) })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Booking ref">
            <input
              value={editingItem.bookingRef || ''}
              onChange={(event) => onChange({ bookingRef: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Category">
            <input
              value={editingItem.category}
              onChange={(event) => onChange({ category: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
        </div>

        <Field label="Notes" className="mt-4">
          <textarea
            rows={5}
            value={editingItem.description || ''}
            onChange={(event) => onChange({ description: event.target.value })}
            className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
          />
        </Field>
      </div>
    </div>
  )
}

function ActionSheet({ actionItem, onClose, onEdit }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-slate-950/45 p-4 backdrop-blur-sm" onClick={onClose}>
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
            onClick={() => {
              navigator.clipboard?.writeText(`${actionItem.lat}, ${actionItem.lng}`)
              onClose()
            }}
            className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-4 text-sm font-bold text-slate-900"
          >
            Copy coordinates
            <Copy className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="flex w-full items-center justify-between rounded-2xl bg-slate-100 px-4 py-4 text-sm font-bold text-slate-900"
          >
            Edit details
            <MapPinned className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function MapPanel({ activeDay, filteredItems, movementPoints, routeSegments, viewMode }) {
  return (
    <>
      <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Movement view</p>
            <h2 className="headline mt-2 text-3xl text-slate-900">Interactive map</h2>
          </div>
          <div className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white">
            {activeDay === 'All' ? 'Whole trip' : formatDay(activeDay)}
          </div>
        </div>

        <div className={`mt-4 overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-100 ${viewMode === 'mobile' ? 'h-[320px]' : 'h-[420px]'}`}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center bg-slate-100 text-sm font-semibold text-slate-500">
                Loading map...
              </div>
            }
          >
            <TripMap filteredItems={filteredItems} movementPoints={movementPoints} routeSegments={routeSegments} />
          </Suspense>
        </div>
      </div>

      <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Route list</p>
            <h3 className="headline mt-2 text-2xl text-slate-900">Movement summary</h3>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {routeSegments.length ? (
            routeSegments.map((segment) => (
              <div key={segment.id} className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="text-sm font-semibold text-slate-900">
                  {segment.from.title} → {segment.to.title}
                </div>
                <div className="mt-1 text-sm text-slate-600">
                  {segment.route
                    ? `${routeLabel(segment.mode)} ${Math.round(segment.route.durationMin)} min · ${segment.route.distanceKm.toFixed(1)} km`
                    : 'Route loading'}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-2xl bg-white p-4 text-sm text-slate-600 shadow-sm">
              Add more locations to visualize movement between stops.
            </div>
          )}
        </div>
      </div>
    </>
  )
}

const MemoMapPanel = memo(MapPanel)

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
