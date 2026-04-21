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
  Check,
  Cloud,
  CloudRain,
  Copy,
  ExternalLink,
  Loader2,
  MapPinned,
  Navigation,
  Plus,
  Search,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { STATIC_ITINERARY, TRIP_DATES } from './data/seedItinerary'
import {
  ensureAnonymousAuth,
  firebaseEnabled,
  hideItemOverride,
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

function getLocation(item) {
  return item.location || item.venue || ''
}

function typeMeta(category) {
  if (category === 'Flight') return { tone: 'bg-sky-50 text-sky-600' }
  if (category === 'Car') return { tone: 'bg-indigo-50 text-indigo-600' }
  if (category === 'Hotel') return { tone: 'bg-amber-50 text-amber-600' }
  if (category === 'Wedding') return { tone: 'bg-pink-50 text-pink-600' }
  return { tone: 'bg-emerald-50 text-emerald-600' }
}

function distanceKm(from, to) {
  const latDiff = (to.lat - from.lat) * 111
  const lngDiff = (to.lng - from.lng) * 91
  return Math.sqrt(latDiff ** 2 + lngDiff ** 2)
}

function routeLabel(mode) {
  return mode === 'foot' ? 'Walk' : 'Drive'
}

function getWeatherDisplay(activeDay, weatherState, selectedWeather) {
  if (activeDay === 'All') {
    return null
  }

  if (weatherState.loading) {
    return {
      headline: 'Loading weather',
      detail: 'Checking the Open-Meteo forecast for this day.',
      icon: Cloud,
    }
  }

  if (weatherState.error) {
    return {
      headline: weatherState.error,
      detail: 'Live weather could not be loaded right now.',
      icon: Cloud,
    }
  }

  if (selectedWeather) {
    return {
      headline: `${Math.round(selectedWeather.tempMax)}° · Rain ${selectedWeather.rainProbability ?? 0}%`,
      detail: selectedWeather.label,
      icon: selectedWeather.rainProbability >= 40 ? CloudRain : Sun,
    }
  }

  const availableDates = weatherState.data?.availableDates || []
  const firstAvailable = availableDates[0]
  const lastAvailable = availableDates[availableDates.length - 1]

  return {
    headline: 'Forecast not available yet',
    detail:
      firstAvailable && lastAvailable
        ? `Open-Meteo currently covers ${formatDay(firstAvailable)} to ${formatDay(lastAvailable)} only.`
        : 'Open-Meteo has not returned a usable forecast window yet.',
    icon: Cloud,
  }
}

function normalizeItem(item) {
  return {
    ...item,
    location: getLocation(item),
  }
}

function mergeItems(overrides) {
  const staticIds = new Set(STATIC_ITINERARY.map((item) => item.id))
  const mergedStatic = STATIC_ITINERARY.map((item) =>
    normalizeItem({ ...item, ...(overrides[item.id] || {}) }),
  ).filter((item) => !item.hidden)
  const userItems = Object.entries(overrides)
    .filter(([id]) => !staticIds.has(id))
    .map(([id, item]) =>
      normalizeItem({
        id,
        ...item,
      }),
    )
    .filter((item) => !item.hidden)

  return [...mergedStatic, ...userItems].sort((a, b) => a.startISO.localeCompare(b.startISO))
}

function getRoutePairs(items) {
  return items
    .slice(0, -1)
    .map((item, index) => [item, items[index + 1]])
    .filter(([from, to]) => typeof from.lat === 'number' && typeof to.lat === 'number')
}

function useResponsiveMode() {
  const [isMobilePortrait, setIsMobilePortrait] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(max-width: 900px)').matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const media = window.matchMedia('(max-width: 900px)')
    const update = () => {
      setIsMobilePortrait(media.matches)
    }

    update()
    media.addEventListener('change', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)

    return () => {
      media.removeEventListener('change', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  return isMobilePortrait
}

export default function App() {
  const [activeDay, setActiveDay] = useState('All')
  const [overrides, setOverrides] = useState({})
  const [authReady, setAuthReady] = useState(false)
  const [firestoreState, setFirestoreState] = useState({
    status: firebaseEnabled ? 'connecting' : 'disabled',
    error: '',
  })
  const [weatherState, setWeatherState] = useState({ loading: true, data: null, error: '' })
  const [noteItem, setNoteItem] = useState(null)
  const [detailItem, setDetailItem] = useState(null)
  const [autosaveStatus, setAutosaveStatus] = useState(firebaseEnabled ? 'saved' : 'offline')
  const [routeMap, setRouteMap] = useState({})

  const isMobilePortrait = useResponsiveMode()
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
  const firestoreReady = firebaseEnabled && authReady && firestoreState.status === 'ready'

  useEffect(() => {
    let active = true
    let unsubscribe = () => {}

    async function bootstrap() {
      if (!firebaseEnabled) {
        if (active) {
          setAuthReady(true)
          setFirestoreState({ status: 'disabled', error: 'Firebase env vars missing' })
        }
        return
      }

      try {
        await ensureAnonymousAuth()
        if (!active) return

        setAuthReady(true)
        unsubscribe = await subscribeToOverrides(
          (payload) => {
            setOverrides(payload?.items || {})
            setFirestoreState({ status: 'ready', error: '' })
          },
          (error) => {
            console.error(error)
            if (active) {
              setFirestoreState({ status: 'error', error: error?.message || 'Snapshot failed' })
            }
          },
        )
      } catch (error) {
        console.error(error)
        if (active) {
          setAuthReady(true)
          setFirestoreState({ status: 'error', error: error?.message || 'Auth failed' })
        }
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
    if (!detailItem || !firebaseEnabled || !authReady) return

    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current)
    }

    debounceRef.current = window.setTimeout(async () => {
      try {
        await upsertItemOverride(detailItem.id, {
          title: detailItem.title,
          location: detailItem.location,
          description: detailItem.description,
          bookingRef: detailItem.bookingRef,
          startISO: detailItem.startISO,
          endISO: detailItem.endISO,
          category: detailItem.category,
          lat: detailItem.lat,
          lng: detailItem.lng,
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
  }, [detailItem, authReady])

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

  function openNotes(item) {
    setNoteItem({
      id: item.id,
      title: item.title,
      description: item.description || '',
      bookingRef: item.bookingRef || '',
      location: item.location,
    })
  }

  function openDetails(item) {
    if (!firestoreReady) return
    setAutosaveStatus('saved')
    setDetailItem({ ...item })
  }

  function updateDetail(changes) {
    if (!firestoreReady) return
    setAutosaveStatus('saving')
    setDetailItem((current) => (current ? { ...current, ...changes } : current))
  }

  async function deleteItem(itemId) {
    if (!firestoreReady) return

    try {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current)
      }
      await hideItemOverride(itemId)
      setNoteItem((current) => (current?.id === itemId ? null : current))
      setDetailItem((current) => (current?.id === itemId ? null : current))
    } catch (error) {
      console.error(error)
      setFirestoreState({ status: 'error', error: error?.message || 'Delete failed' })
    }
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
          openDetails(item)
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

    const shouldOpenNotes = !state.moved && !state.longPressed && state.itemId === item.id
    clearPressState()
    if (shouldOpenNotes) {
      openNotes(item)
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-5 text-slate-900 sm:px-6 lg:px-8">
      <section className="glass-panel rounded-[2rem] border border-white/60 px-5 py-5 sm:px-7">
        <div className="flex items-center justify-between gap-4">
          <h1 className="headline text-3xl leading-tight sm:text-5xl">Trip planner</h1>
          {firestoreState.status === 'error' ? (
            <div className="rounded-full bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-rose-600">
              Firestore error
            </div>
          ) : null}
        </div>
      </section>

      <section
        className={
          isMobilePortrait
            ? 'mx-auto mt-6 max-w-md space-y-4'
            : 'mt-6 grid gap-6 lg:grid-cols-[1.06fr_0.94fr]'
        }
      >
        <div className="space-y-4">
          <PlannerPanel
            activeDay={activeDay}
            filteredItems={filteredItems}
            firestoreReady={firestoreReady}
            firestoreState={firestoreState}
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
            isMobilePortrait={isMobilePortrait}
          />
        </div>

        <div className="space-y-4">
          <MemoMapPanel
            activeDay={activeDay}
            filteredItems={deferredItems}
            movementPoints={movementPoints}
            routeSegments={routeSegments}
            isMobilePortrait={isMobilePortrait}
          />
        </div>
      </section>

      {noteItem ? (
        <NoteModal
          item={noteItem}
          firestoreReady={firestoreReady}
          isMobilePortrait={isMobilePortrait}
          onClose={() => setNoteItem(null)}
          onDelete={async () => {
            const id = noteItem.id
            setNoteItem(null)
            await deleteItem(id)
          }}
          onOpenDetails={() => {
            const match = items.find((item) => item.id === noteItem.id)
            setNoteItem(null)
            if (match) {
              openDetails(match)
            }
          }}
        />
      ) : null}

      {detailItem ? (
        <DetailModal
          key={detailItem.id}
          autosaveStatus={autosaveStatus}
          detailItem={detailItem}
          firestoreReady={firestoreReady}
          firestoreState={firestoreState}
          isMobilePortrait={isMobilePortrait}
          onChange={updateDetail}
          onClose={() => setDetailItem(null)}
          onDelete={async () => {
            const id = detailItem.id
            await deleteItem(id)
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
  firestoreState,
  routeSegments,
  onDayChange,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onPointerCancel,
  onSaveNewItem,
  selectedWeather,
  weatherState,
  isMobilePortrait,
}) {
  const weatherDisplay = getWeatherDisplay(activeDay, weatherState, selectedWeather)
  const [searchState, setSearchState] = useState({
    loading: false,
    results: [],
    error: '',
    searched: false,
  })
  const [newItem, setNewItem] = useState({
    date: '2026-05-10',
    time: '10:00',
    category: 'Activity',
    title: '',
    location: '',
    description: '',
    bookingRef: '',
    lat: null,
    lng: null,
    query: '',
  })

  async function runSearch() {
    try {
      setSearchState({ loading: true, results: [], error: '', searched: false })
      const results = await searchPlaces(newItem.query)
      setSearchState({ loading: false, results, error: '', searched: true })
    } catch (error) {
      console.error(error)
      setSearchState({
        loading: false,
        results: [],
        error: 'OpenStreetMap search failed',
        searched: true,
      })
    }
  }

  async function saveNewItem() {
    if (!firestoreReady) return

    const id = `user-${Date.now()}`
    const startISO = `${newItem.date}T${newItem.time}:00+09:00`

    await onSaveNewItem(id, {
      id,
      title: newItem.title || 'New plan item',
      location: newItem.location || 'Location TBD',
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
      location: '',
      description: '',
      bookingRef: '',
      lat: null,
      lng: null,
      query: '',
    }))
    setSearchState({ loading: false, results: [], error: '', searched: false })
  }

  return (
    <>
      <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="headline text-3xl text-slate-900">
            {activeDay === 'All' ? 'Full itinerary' : formatDay(activeDay)}
          </h2>
          <div className="rounded-full bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Tap notes · Hold details
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

        {weatherDisplay ? (
          <div className="mt-4 rounded-[1.4rem] bg-white px-4 py-4 shadow-sm">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Weather snapshot</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-lg font-bold text-slate-900">{weatherDisplay.headline}</div>
                <div className="mt-1 text-sm text-slate-600">{weatherDisplay.detail}</div>
              </div>
              <div className="rounded-2xl bg-slate-100 p-3 text-slate-700">
                <weatherDisplay.icon className="h-5 w-5" />
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
                    <MapPinned className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] font-black uppercase tracking-[0.18em] text-indigo-600">
                        {getTimeValue(item.startISO)}
                      </span>
                    </div>
                    <h3 className="mt-1 text-lg font-bold text-slate-900">{item.title}</h3>
                    <p className="mt-1 text-sm text-slate-600">{item.location}</p>
                    <p className="mt-3 rounded-2xl bg-slate-50 px-3 py-2 text-sm text-slate-500">
                      {item.description || 'Tap to open notes.'}
                    </p>
                  </div>
                </div>
              </article>

              {nextSegment ? (
                <div className="rounded-[1.25rem] bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                  {nextSegment.route
                    ? `${routeLabel(nextSegment.mode)} ${Math.round(nextSegment.route.durationMin)} min · ${nextSegment.route.distanceKm.toFixed(1)} km`
                    : `Fetching route to ${nextSegment.to.title}`}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
        <div className="flex items-center justify-between">
          <h3 className="headline text-2xl text-slate-900">New stop</h3>
          <div className="rounded-2xl bg-slate-900 p-3 text-white">
            <Plus className="h-5 w-5" />
          </div>
        </div>

        <div className={`mt-4 grid gap-4 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
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
          <Field label="Location search">
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
            <SearchResults
              results={searchState.results}
              onSelect={(result) => {
                setNewItem((current) => ({
                  ...current,
                  location: result.label,
                  query: result.label,
                  lat: result.lat,
                  lng: result.lng,
                }))
                setSearchState({ loading: false, results: [], error: '', searched: true })
              }}
            />
          ) : null}

          <SearchFeedback searchState={searchState} />

          <Field label="Location">
            <input
              value={newItem.location}
              onChange={(event) => setNewItem((current) => ({ ...current, location: event.target.value }))}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Notes">
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
          title={!firestoreReady ? firestoreButtonLabel(firestoreState) : undefined}
          className="mt-4 w-full rounded-[1.4rem] bg-indigo-600 px-4 py-4 text-sm font-bold text-white shadow-lg shadow-indigo-100"
        >
          {firestoreReady ? 'Save new itinerary detail' : firestoreButtonLabel(firestoreState)}
        </button>
      </div>
    </>
  )
}

function SearchResults({ results, onSelect }) {
  return (
    <div className="space-y-2 rounded-2xl bg-slate-50 p-3">
      {results.map((result) => (
        <button
          key={`${result.lat}-${result.lng}`}
          type="button"
          onClick={() => onSelect(result)}
          className="block w-full rounded-2xl bg-white px-4 py-3 text-left text-sm text-slate-700"
        >
          {result.label}
        </button>
      ))}
    </div>
  )
}

function SearchFeedback({ searchState }) {
  if (searchState.loading) return null

  if (searchState.error) {
    return (
      <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-600">
        {searchState.error}
      </div>
    )
  }

  if (searchState.searched && !searchState.results.length) {
    return (
      <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
        No places matched that search.
      </div>
    )
  }

  return null
}

function NoteModal({ item, firestoreReady, isMobilePortrait, onClose, onDelete, onOpenDetails }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <div className={`glass-panel w-full border border-white/60 p-6 ${isMobilePortrait ? 'rounded-[2rem] sm:max-w-md' : 'max-w-lg rounded-[2rem]'}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-900">{item.title}</h3>
            <p className="mt-1 text-sm text-slate-600">{item.location}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={!firestoreReady}
              className="rounded-full bg-rose-50 p-2 text-rose-600 disabled:bg-slate-100 disabled:text-slate-400"
              aria-label="Delete item"
            >
              <Trash2 className="h-5 w-5" />
            </button>
            <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="rounded-2xl bg-white px-4 py-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Notes</div>
            <div className="mt-2 text-sm text-slate-700 whitespace-pre-wrap">
              {item.description || 'No notes yet.'}
            </div>
          </div>
          {item.bookingRef ? (
            <div className="rounded-2xl bg-white px-4 py-4 shadow-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Booking ref</div>
              <div className="mt-2 text-sm font-semibold text-slate-900">{item.bookingRef}</div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onOpenDetails}
          className="mt-5 w-full rounded-[1.4rem] bg-slate-900 px-4 py-4 text-sm font-bold text-white"
        >
          Open details
        </button>
      </div>
    </div>
  )
}

function DetailModal({
  autosaveStatus,
  detailItem,
  firestoreReady,
  firestoreState,
  isMobilePortrait,
  onChange,
  onClose,
  onDelete,
}) {
  const [searchState, setSearchState] = useState({
    loading: false,
    results: [],
    error: '',
    searched: false,
  })
  const [searchQuery, setSearchQuery] = useState(detailItem.location || '')

  async function runSearch() {
    try {
      setSearchState({ loading: true, results: [], error: '', searched: false })
      const results = await searchPlaces(searchQuery)
      setSearchState({ loading: false, results, error: '', searched: true })
    } catch (error) {
      console.error(error)
      setSearchState({
        loading: false,
        results: [],
        error: 'OpenStreetMap search failed',
        searched: true,
      })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <div className={`glass-panel w-full border border-white/60 p-6 ${isMobilePortrait ? 'rounded-[2rem] sm:max-w-md' : 'max-w-2xl rounded-[2rem]'}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-900">{detailItem.title}</h3>
            <div className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {autosaveStatus === 'saving' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {autosaveStatus === 'saving'
                ? 'Autosaving...'
                : autosaveStatus === 'error'
                  ? 'Save failed'
                  : 'All changes synced'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onDelete()}
              disabled={!firestoreReady}
              className="rounded-full bg-rose-50 p-2 text-rose-600 disabled:bg-slate-100 disabled:text-slate-400"
              aria-label="Delete item"
            >
              <Trash2 className="h-5 w-5" />
            </button>
            <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className={`mt-5 grid gap-4 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
          <Field label="Title">
            <input
              value={detailItem.title}
              onChange={(event) => onChange({ title: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Category">
            <input
              value={detailItem.category}
              onChange={(event) => onChange({ category: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={getDateKey(detailItem.startISO)}
              onChange={(event) =>
                onChange({
                  startISO: replaceDate(detailItem.startISO, event.target.value),
                  endISO: replaceDate(detailItem.endISO, event.target.value),
                })
              }
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Start time">
            <input
              type="time"
              value={getTimeValue(detailItem.startISO)}
              onChange={(event) => onChange({ startISO: replaceTime(detailItem.startISO, event.target.value) })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
        </div>

        <div className="mt-4 space-y-3">
          <Field label="Location search">
            <div className="flex gap-2">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
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
            <SearchResults
              results={searchState.results}
              onSelect={(result) => {
                setSearchQuery(result.label)
                onChange({
                  location: result.label,
                  lat: result.lat,
                  lng: result.lng,
                })
                setSearchState({ loading: false, results: [], error: '', searched: true })
              }}
            />
          ) : null}

          <SearchFeedback searchState={searchState} />

          <Field label="Location">
            <input
              value={detailItem.location || ''}
              onChange={(event) => onChange({ location: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Booking ref">
            <input
              value={detailItem.bookingRef || ''}
              onChange={(event) => onChange({ bookingRef: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
          <Field label="Notes">
            <textarea
              rows={5}
              value={detailItem.description || ''}
              onChange={(event) => onChange({ description: event.target.value })}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
            />
          </Field>
        </div>

        <div className={`mt-5 grid gap-2 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
          <a
            href={
              typeof detailItem.lat === 'number' && typeof detailItem.lng === 'number'
                ? `https://www.google.com/maps/search/?api=1&query=${detailItem.lat},${detailItem.lng}`
                : '#'
            }
            target="_blank"
            rel="noreferrer"
            className={`flex items-center justify-between rounded-2xl px-4 py-4 text-sm font-bold ${
              typeof detailItem.lat === 'number' && typeof detailItem.lng === 'number'
                ? 'bg-indigo-600 text-white'
                : 'pointer-events-none bg-slate-100 text-slate-400'
            }`}
          >
            Open in Google Maps
            <ExternalLink className="h-4 w-4" />
          </a>
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(`${detailItem.lat}, ${detailItem.lng}`)}
            disabled={typeof detailItem.lat !== 'number' || typeof detailItem.lng !== 'number'}
            className="flex items-center justify-between rounded-2xl bg-white px-4 py-4 text-sm font-bold text-slate-900 disabled:text-slate-400"
          >
            Copy coordinates
            <Copy className="h-4 w-4" />
          </button>
        </div>

        {!firestoreReady ? (
          <div className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-rose-500">
            {firestoreButtonLabel(firestoreState)}
          </div>
        ) : null}

      </div>
    </div>
  )
}

function MapPanel({ activeDay, filteredItems, movementPoints, routeSegments, isMobilePortrait }) {
  return (
    <>
      <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="headline text-3xl text-slate-900">Map</h2>
          <div className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white">
            {activeDay === 'All' ? 'Whole trip' : formatDay(activeDay)}
          </div>
        </div>

        <div className={`mt-4 overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-100 ${isMobilePortrait ? 'h-[320px]' : 'h-[420px]'}`}>
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
        <h3 className="headline text-2xl text-slate-900">Movement</h3>
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

function firestoreButtonLabel(firestoreState) {
  if (firestoreState.status === 'ready') return 'Save new itinerary detail'
  if (firestoreState.status === 'connecting') return 'Connecting to Firestore'
  if (firestoreState.status === 'error') return 'Firestore error'
  return 'Firestore not configured'
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
