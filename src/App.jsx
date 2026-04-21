import React, {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  CalendarDays,
  CarFront,
  Check,
  CloudDrizzle,
  CloudFog,
  CloudSun,
  Copy,
  DollarSign,
  LoaderCircle,
  MapPinned,
  Navigation,
  NotebookPen,
  Route,
  ShieldAlert,
  ShoppingBag,
  Snowflake,
  Sparkles,
  SunMedium,
  Umbrella,
  WalletCards,
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
import { STATIC_ITINERARY, TRIP_DATES, TRIP_EXPENSES } from './data/seedItinerary'
import {
  ensureAnonymousAuth,
  firebaseEnabled,
  subscribeToOverrides,
  upsertItemOverride,
} from './services/firebase'
import { fetchLatestJpyHkdRate } from './services/currency'
import { fetchRoadRoute } from './services/osrm'
import { fetchWeatherSnapshot } from './services/weather'

const SAVE_DEBOUNCE_MS = 1000

const formatDateChip = (date) =>
  new Intl.DateTimeFormat('en-HK', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(`${date}T00:00:00+09:00`))

const formatDateHeading = (date) =>
  new Intl.DateTimeFormat('en-HK', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(`${date}T00:00:00+09:00`))

const formatCurrency = (value, currency) =>
  new Intl.NumberFormat('en-HK', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'JPY' ? 0 : 2,
  }).format(value)

const getDateKey = (iso) => iso.slice(0, 10)
const getTimeLabel = (iso) => iso.slice(11, 16)
const isoToMinutes = (iso) => new Date(iso).getTime() / 60000
const replaceTimeInIso = (iso, nextTime) => `${iso.slice(0, 10)}T${nextTime}:00+09:00`
const buildRouteKey = (from, to) => `${from.id}:${to.id}:${from.lat},${from.lng}:${to.lat},${to.lng}`

function mergeItinerary(staticItems, overrides) {
  return staticItems
    .map((item) => ({ ...item, ...(overrides[item.id] || {}) }))
    .sort((a, b) => a.startISO.localeCompare(b.startISO))
}

function mergeRemoteOverrides(currentOverrides, remoteItems, dirtyIds) {
  const next = { ...currentOverrides }
  Object.entries(remoteItems).forEach(([itemId, override]) => {
    if (dirtyIds.has(itemId)) return
    next[itemId] = { ...next[itemId], ...override }
  })
  return next
}

function getBufferLabel(bufferMinutes) {
  if (bufferMinutes < 15) return { tone: 'warning', label: 'Tight buffer' }
  if (bufferMinutes > 45) return { tone: 'easy', label: 'Easy pace' }
  return { tone: 'steady', label: 'Manageable' }
}

function WeatherGlyph({ weatherKey, className }) {
  if (weatherKey === 'clear') return <SunMedium className={className} />
  if (weatherKey === 'cloudy') return <CloudSun className={className} />
  if (weatherKey === 'fog') return <CloudFog className={className} />
  if (weatherKey === 'snow') return <Snowflake className={className} />
  if (weatherKey === 'thunder') return <Umbrella className={className} />
  return <CloudDrizzle className={className} />
}

function FitSelectedBounds({ points }) {
  const map = useMap()

  useEffect(() => {
    if (!points.length) return
    if (points.length === 1) {
      map.setView(points[0], 12)
      return
    }
    map.fitBounds(points, { padding: [36, 36] })
  }, [map, points])

  return null
}

function StatusCard({ icon, eyebrow, title, children }) {
  const IconGlyph = icon

  return (
    <div className="rounded-[1.6rem] border border-white/60 bg-white/72 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{eyebrow}</p>
          <h2 className="mt-2 text-lg font-bold text-slate-900">{title}</h2>
        </div>
        <div className="rounded-2xl bg-slate-900 p-3 text-white">
          <IconGlyph className="h-5 w-5" />
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  )
}

function LoadingLine({ label }) {
  return (
    <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
      <LoaderCircle className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

function InputGroup({ label, value, onChange, type = 'text', inputMode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
        {label}
      </span>
      <input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-500"
      />
    </label>
  )
}

function StatusPill({ label, good }) {
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
        good ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'
      }`}
    >
      {good ? <Check className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
      {label}
    </div>
  )
}

function App() {
  const [selectedDate, setSelectedDate] = useState(TRIP_DATES[0])
  const [overrides, setOverrides] = useState({})
  const [authState, setAuthState] = useState(firebaseEnabled ? 'connecting' : 'disabled')
  const [saveState, setSaveState] = useState(firebaseEnabled ? 'saved' : 'local-only')
  const [weatherState, setWeatherState] = useState({ loading: true, data: null, error: '' })
  const [rateState, setRateState] = useState({ loading: true, data: null, error: '' })
  const [routeState, setRouteState] = useState({ loading: false, map: {} })
  const [navigatorItem, setNavigatorItem] = useState(null)
  const [activeItemId, setActiveItemId] = useState(STATIC_ITINERARY[0]?.id ?? null)
  const [converter, setConverter] = useState({ jpy: '10000', hkd: '' })
  const [copyState, setCopyState] = useState('')
  const dirtyIdsRef = useRef(new Set())
  const [dirtyVersion, setDirtyVersion] = useState(0)
  const pressRegistryRef = useRef(new Map())
  const routeCacheRef = useRef(new Map())

  const itinerary = useMemo(() => mergeItinerary(STATIC_ITINERARY, overrides), [overrides])
  const selectedDayItems = useMemo(
    () => itinerary.filter((item) => getDateKey(item.startISO) === selectedDate),
    [itinerary, selectedDate],
  )
  const deferredSelectedDayItems = useDeferredValue(selectedDayItems)
  const activeItem = itinerary.find((item) => item.id === activeItemId) || selectedDayItems[0] || null
  const weatherSnapshot = weatherState.data?.dailyByDate?.[selectedDate] ?? null
  const mapPoints = selectedDayItems.map((item) => [item.lat, item.lng])

  const routeSegments = useMemo(
    () =>
      selectedDayItems.slice(0, -1).map((item, index) => {
        const next = selectedDayItems[index + 1]
        const routeKey = buildRouteKey(item, next)
        const route = routeState.map[routeKey]
        const bufferMinutes = isoToMinutes(next.startISO) - isoToMinutes(item.endISO) - (route?.durationMin ?? 0)

        return {
          id: routeKey,
          route,
          pace: getBufferLabel(bufferMinutes),
          bufferMinutes,
        }
      }),
    [routeState.map, selectedDayItems],
  )

  const flushDirtyItems = useEffectEvent(async (itemIds) => {
    if (!firebaseEnabled) return

    try {
      setSaveState('saving')
      for (const itemId of itemIds) {
        const latest = overrides[itemId]
        if (!latest) continue
        await upsertItemOverride(itemId, latest)
        dirtyIdsRef.current.delete(itemId)
      }
      setSaveState('saved')
    } catch (error) {
      console.error(error)
      setSaveState('error')
    }
  })

  useEffect(() => {
    let unsubscribe = () => {}

    async function bootstrapSync() {
      if (!firebaseEnabled) return

      try {
        await ensureAnonymousAuth()
        setAuthState('connected')
        unsubscribe = subscribeToOverrides(
          (payload) => {
            setOverrides((current) =>
              mergeRemoteOverrides(current, payload?.items || {}, dirtyIdsRef.current),
            )
          },
          (error) => {
            console.error(error)
            setAuthState('error')
          },
        )
      } catch (error) {
        console.error(error)
        setAuthState('error')
      }
    }

    bootstrapSync()
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
        if (!cancelled) {
          setWeatherState({
            loading: false,
            data: null,
            error: 'Weather snapshot is temporarily unavailable.',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchLatestJpyHkdRate()
      .then((data) => {
        if (!cancelled) {
          setRateState({ loading: false, data, error: '' })
          setConverter((current) => ({
            ...current,
            hkd: data.rate ? (Number(current.jpy || 0) * data.rate).toFixed(2) : '',
          }))
        }
      })
      .catch((error) => {
        console.error(error)
        if (!cancelled) {
          setRateState({ loading: false, data: null, error: 'Live rate is unavailable right now.' })
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!firebaseEnabled || dirtyIdsRef.current.size === 0) return
    setSaveState('pending')
    const pendingIds = Array.from(dirtyIdsRef.current)
    const timeoutId = window.setTimeout(() => void flushDirtyItems(pendingIds), SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [dirtyVersion, overrides])

  useEffect(() => {
    let cancelled = false
    const pairs = deferredSelectedDayItems
      .slice(0, -1)
      .map((item, index) => [item, deferredSelectedDayItems[index + 1]])

    if (!pairs.length) return

    async function loadRoutes() {
      setRouteState((current) => ({ ...current, loading: true }))

      const entries = await Promise.all(
        pairs.map(async ([from, to]) => {
          const routeKey = buildRouteKey(from, to)
          const cached = routeCacheRef.current.get(routeKey)
          if (cached) return [routeKey, cached]

          try {
            const route = await fetchRoadRoute(from, to)
            if (route) routeCacheRef.current.set(routeKey, route)
            return [routeKey, route]
          } catch (error) {
            console.error(error)
            return [routeKey, null]
          }
        }),
      )

      if (!cancelled) setRouteState({ loading: false, map: Object.fromEntries(entries) })
    }

    loadRoutes()
    return () => {
      cancelled = true
    }
  }, [deferredSelectedDayItems])

  function commitLocalEdit(itemId, changes) {
    setOverrides((current) => ({
      ...current,
      [itemId]: { ...current[itemId], ...changes },
    }))
    dirtyIdsRef.current.add(itemId)
    setDirtyVersion((value) => value + 1)
  }

  function handleConverterChange(field, value) {
    if (!rateState.data?.rate) {
      setConverter((current) => ({ ...current, [field]: value }))
      return
    }

    if (field === 'jpy') {
      setConverter({ jpy: value, hkd: value ? (Number(value) * rateState.data.rate).toFixed(2) : '' })
      return
    }

    setConverter({ hkd: value, jpy: value ? (Number(value) / rateState.data.rate).toFixed(0) : '' })
  }

  function openEditSheet(item) {
    setActiveItemId(item.id)
  }

  function openNavigatorMenu(item) {
    navigator.vibrate?.(35)
    setNavigatorItem(item)
  }

  function getPressState(itemId) {
    if (!pressRegistryRef.current.has(itemId)) {
      pressRegistryRef.current.set(itemId, {
        timerId: null,
        moved: false,
        longPressed: false,
        startX: 0,
        startY: 0,
      })
    }
    return pressRegistryRef.current.get(itemId)
  }

  function cancelPress(itemId) {
    const state = getPressState(itemId)
    if (state.timerId) {
      window.clearTimeout(state.timerId)
      state.timerId = null
    }
  }

  function buildPressHandlers(item) {
    function beginPress(clientX, clientY) {
      const state = getPressState(item.id)
      state.moved = false
      state.longPressed = false
      state.startX = clientX
      state.startY = clientY
      cancelPress(item.id)
      state.timerId = window.setTimeout(() => {
        state.longPressed = true
        openNavigatorMenu(item)
      }, 600)
    }

    function movePress(clientX, clientY) {
      const state = getPressState(item.id)
      const travel = Math.abs(clientX - state.startX) + Math.abs(clientY - state.startY)
      if (travel > 14) {
        state.moved = true
        cancelPress(item.id)
      }
    }

    function endPress() {
      const state = getPressState(item.id)
      cancelPress(item.id)
      if (!state.moved && !state.longPressed) openEditSheet(item)
    }

    return {
      onMouseDown: (event) => beginPress(event.clientX, event.clientY),
      onMouseLeave: () => cancelPress(item.id),
      onMouseUp: endPress,
      onTouchStart: (event) => {
        const touch = event.touches[0]
        beginPress(touch.clientX, touch.clientY)
      },
      onTouchMove: (event) => {
        const touch = event.touches[0]
        movePress(touch.clientX, touch.clientY)
      },
      onTouchCancel: () => cancelPress(item.id),
      onTouchEnd: endPress,
    }
  }

  async function copyCoordinates(item) {
    try {
      await navigator.clipboard.writeText(`${item.lat}, ${item.lng}`)
      setCopyState('Coordinates copied')
      window.setTimeout(() => setCopyState(''), 1600)
    } catch (error) {
      console.error(error)
      setCopyState('Copy failed')
      window.setTimeout(() => setCopyState(''), 1600)
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-5 text-slate-900 sm:px-6 lg:px-8">
      <section className="glass-panel animate-float-in overflow-hidden rounded-[2rem] border border-white/60">
        <div className="grid gap-8 px-5 py-6 sm:px-8 lg:grid-cols-[1.15fr_0.85fr] lg:px-10 lg:py-10">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-teal-900/10 bg-white/60 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-teal-900/70">
              <Sparkles className="h-3.5 w-3.5" />
              May 9-13, 2026 - Chiba / Tokyo wedding run
            </div>
            <div className="space-y-3">
              <h1 className="headline max-w-3xl text-4xl leading-tight text-slate-900 sm:text-5xl lg:text-6xl">
                Family trip planning with live weather, outlet math, and cloud override syncing.
              </h1>
              <p className="max-w-2xl text-sm leading-7 text-slate-700 sm:text-base">
                Single tap opens notes and edits. Long press for navigation actions. Every title,
                time, and booking detail edit debounces into Firestore after 1 second.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <StatusCard icon={CalendarDays} eyebrow="Daily Weather Snapshot" title={formatDateHeading(selectedDate)}>
                {weatherState.loading ? (
                  <LoadingLine label="Loading corridor weather..." />
                ) : weatherSnapshot ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="rounded-2xl bg-amber-400/15 p-3 text-amber-600">
                        <WeatherGlyph weatherKey={weatherSnapshot.weatherKey} className="h-6 w-6" />
                      </div>
                      <div>
                        <div className="text-lg font-semibold text-slate-900">
                          {Math.round(weatherSnapshot.tempMax)} / {Math.round(weatherSnapshot.tempMin)} deg C
                        </div>
                        <div className="text-xs text-slate-600">{weatherSnapshot.label}</div>
                      </div>
                    </div>
                    <div className="rounded-2xl bg-slate-900 px-3 py-2 text-xs font-medium text-white">
                      Rain Probability: {weatherSnapshot.rainProbability ?? 0}%
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-600">{weatherState.error}</p>
                )}
              </StatusCard>

              <StatusCard icon={WalletCards} eyebrow="Sync / Auth" title={firebaseEnabled ? 'Anonymous cloud mode' : 'Local preview mode'}>
                <div className="space-y-2 text-sm text-slate-700">
                  <StatusPill label={`Auth: ${authState}`} good={authState === 'connected'} />
                  <StatusPill label={`Autosave: ${saveState}`} good={saveState === 'saved'} />
                  <p className="text-xs leading-6 text-slate-500">
                    Static seed data stays in code. Edits persist as Firestore cloud overrides.
                  </p>
                </div>
              </StatusCard>

              <StatusCard icon={DollarSign} eyebrow="Outlet Math Tool" title="JPY to HKD">
                <div className="space-y-2">
                  <InputGroup label="JPY" inputMode="decimal" value={converter.jpy} onChange={(value) => handleConverterChange('jpy', value)} />
                  <InputGroup label="HKD" inputMode="decimal" value={converter.hkd} onChange={(value) => handleConverterChange('hkd', value)} />
                  <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-500">
                    {rateState.loading
                      ? 'Refreshing rate...'
                      : rateState.data
                        ? `Frankfurter ${rateState.data.date} - 1 JPY = ${rateState.data.rate.toFixed(4)} HKD`
                        : rateState.error}
                  </div>
                </div>
              </StatusCard>
            </div>
          </div>

          <div className="space-y-4 rounded-[1.75rem] bg-slate-950 px-5 py-5 text-white shadow-2xl shadow-slate-900/20">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-white/60">Major trip expenses</p>
                <h2 className="headline mt-2 text-3xl">Live HKD view</h2>
              </div>
              <ShoppingBag className="h-8 w-8 text-amber-300" />
            </div>
            <div className="space-y-3">
              {TRIP_EXPENSES.map((expense) => (
                <div key={expense.id} className="rounded-3xl border border-white/10 bg-white/8 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">{expense.label}</div>
                      <div className="text-xs text-white/60">{expense.note}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium text-white/75">{formatCurrency(expense.amountJPY, 'JPY')}</div>
                      <div className="text-lg font-bold text-amber-300">
                        {rateState.data ? formatCurrency(expense.amountJPY * rateState.data.rate, 'HKD') : '--'}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="mt-6 grid gap-6 lg:grid-cols-[1.06fr_0.94fr]">
        <div className="space-y-4">
          <div className="glass-panel rounded-[1.75rem] border border-white/60 p-3 sm:p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.26em] text-slate-500">Trip dates</p>
                <h2 className="headline mt-2 text-3xl text-slate-900">Itinerary runway</h2>
              </div>
              <div className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white">
                Tap / Hold
              </div>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {TRIP_DATES.map((date) => (
                <button
                  key={date}
                  type="button"
                  onClick={() => startTransition(() => setSelectedDate(date))}
                  className={`min-w-[112px] rounded-2xl border px-3 py-3 text-left transition ${
                    date === selectedDate
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white/70 text-slate-800 hover:border-slate-400'
                  }`}
                >
                  <div className="text-xs uppercase tracking-[0.18em] opacity-70">Trip day</div>
                  <div className="mt-1 text-sm font-semibold">{formatDateChip(date)}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            {selectedDayItems.map((item, index) => {
              const nextRoute = routeSegments[index]
              const pressHandlers = buildPressHandlers(item)
              const categoryIcon =
                item.category === 'Transit'
                  ? CarFront
                  : item.category === 'Stay'
                    ? MapPinned
                    : item.category === 'Wedding'
                      ? Umbrella
                      : NotebookPen

              return (
                <div key={item.id} className="space-y-4">
                  <article
                    className={`glass-panel rounded-[1.75rem] border px-4 py-4 transition sm:px-5 ${
                      activeItem?.id === item.id
                        ? 'border-slate-900/60 ring-2 ring-slate-900/10'
                        : 'border-white/60'
                    }`}
                    {...pressHandlers}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                          {React.createElement(categoryIcon, { className: 'h-4 w-4' })}
                          {item.category}
                        </div>
                        <div>
                          <h3 className="text-xl font-bold text-slate-900">{item.title}</h3>
                          <p className="mt-1 text-sm text-slate-600">{item.venue}</p>
                        </div>
                      </div>
                      <div className="rounded-2xl bg-slate-900 px-3 py-2 text-right text-white">
                        <div className="text-xs uppercase tracking-[0.18em] text-white/60">Window</div>
                        <div className="text-sm font-semibold">
                          {getTimeLabel(item.startISO)} - {getTimeLabel(item.endISO)}
                        </div>
                      </div>
                    </div>
                    <p className="mt-4 text-sm leading-7 text-slate-700">{item.description}</p>
                    <div className="mt-4 flex flex-wrap gap-2 text-xs">
                      {item.bookingRef ? (
                        <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-700">
                          Ref: {item.bookingRef}
                        </span>
                      ) : null}
                      <span className="rounded-full bg-teal-100 px-3 py-1 font-medium text-teal-800">
                        ISO: {item.startISO}
                      </span>
                    </div>
                  </article>
                  {nextRoute ? (
                    <div className="glass-panel rounded-[1.4rem] border border-white/60 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="rounded-2xl bg-slate-900 p-2 text-white">
                            <Route className="h-4 w-4" />
                          </div>
                          <div className="text-sm text-slate-700">
                            <div className="font-semibold text-slate-900">
                              {nextRoute.route
                                ? `${nextRoute.route.distanceKm.toFixed(1)} km - ${Math.round(nextRoute.route.durationMin)} min drive`
                                : 'OSRM route pending'}
                            </div>
                            <div className="text-xs text-slate-500">
                              {nextRoute.pace.label} - {Math.round(nextRoute.bufferMinutes)} min buffer
                            </div>
                          </div>
                        </div>
                        <div
                          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${
                            nextRoute.pace.tone === 'warning'
                              ? 'bg-rose-100 text-rose-800'
                              : nextRoute.pace.tone === 'easy'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-amber-100 text-amber-900'
                          }`}
                        >
                          Toddler buffer
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-4">
          <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Interactive navigator</p>
                <h2 className="headline mt-2 text-3xl text-slate-900">Route surface</h2>
              </div>
              {routeState.loading ? <LoadingLine label="Refreshing drive times..." /> : null}
            </div>
            <div className="h-[380px] overflow-hidden rounded-[1.5rem] border border-slate-200 bg-slate-100">
              <MapContainer center={[35.6074, 140.1065]} zoom={10} scrollWheelZoom={false}>
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <FitSelectedBounds points={mapPoints} />
                {selectedDayItems.map((item, index) => (
                  <CircleMarker
                    key={item.id}
                    center={[item.lat, item.lng]}
                    pathOptions={{
                      color: index === 0 ? '#0f766e' : '#1e293b',
                      fillColor: index === 0 ? '#14b8a6' : '#f59e0b',
                      fillOpacity: 0.9,
                    }}
                    radius={10}
                    eventHandlers={{ click: () => setActiveItemId(item.id) }}
                  >
                    <Tooltip direction="top" offset={[0, -8]} opacity={1}>
                      {item.title}
                    </Tooltip>
                    <Popup>
                      <div className="space-y-1">
                        <div className="font-semibold">{item.title}</div>
                        <div className="text-xs text-slate-600">{item.venue}</div>
                      </div>
                    </Popup>
                  </CircleMarker>
                ))}
                {routeSegments
                  .filter((segment) => segment.route?.geometry?.length)
                  .map((segment) => (
                    <Polyline
                      key={segment.id}
                      positions={segment.route.geometry}
                      pathOptions={{ color: '#0f172a', weight: 4, opacity: 0.72 }}
                    />
                  ))}
              </MapContainer>
            </div>
          </div>

          <div className="glass-panel rounded-[1.75rem] border border-white/60 p-4">
            <div className="mb-4 flex items-center gap-3">
              <div className="rounded-2xl bg-amber-100 p-3 text-amber-700">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Editing sheet</p>
                <h2 className="headline text-3xl text-slate-900">{activeItem ? activeItem.title : 'Select a stop'}</h2>
              </div>
            </div>
            {activeItem ? (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <InputGroup label="Title" value={activeItem.title} onChange={(value) => commitLocalEdit(activeItem.id, { title: value })} />
                  <InputGroup label="Booking Ref" value={activeItem.bookingRef || ''} onChange={(value) => commitLocalEdit(activeItem.id, { bookingRef: value })} />
                  <InputGroup label="Start time" type="time" value={getTimeLabel(activeItem.startISO)} onChange={(value) => commitLocalEdit(activeItem.id, { startISO: replaceTimeInIso(activeItem.startISO, value) })} />
                  <InputGroup label="End time" type="time" value={getTimeLabel(activeItem.endISO)} onChange={(value) => commitLocalEdit(activeItem.id, { endISO: replaceTimeInIso(activeItem.endISO, value) })} />
                </div>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Notes / booking details
                  </span>
                  <textarea
                    value={activeItem.description}
                    onChange={(event) => commitLocalEdit(activeItem.id, { description: event.target.value })}
                    rows={5}
                    className="min-h-32 w-full rounded-[1.35rem] border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none transition focus:border-slate-500"
                  />
                </label>
                <div className="rounded-[1.35rem] bg-slate-900 px-4 py-4 text-sm text-white">
                  Autosave cadence: 1000ms debounce into Firestore overrides
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {navigatorItem ? (
        <div className="fixed inset-0 z-20 flex items-end bg-slate-950/45 p-4 sm:items-center sm:justify-center">
          <div className="glass-panel w-full max-w-md rounded-[1.75rem] border border-white/60 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Navigator Menu</p>
                <h3 className="mt-2 text-xl font-bold text-slate-900">{navigatorItem.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{navigatorItem.venue}</p>
              </div>
              <button type="button" onClick={() => setNavigatorItem(null)} className="rounded-full border border-slate-200 px-3 py-1 text-sm font-medium text-slate-600">
                Close
              </button>
            </div>
            <div className="mt-5 space-y-3">
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${navigatorItem.lat},${navigatorItem.lng}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4 text-slate-800"
              >
                <span className="flex items-center gap-3 font-semibold">
                  <Navigation className="h-5 w-5 text-teal-700" />
                  Open in Google Maps
                </span>
              </a>
              <button
                type="button"
                onClick={() => void copyCoordinates(navigatorItem)}
                className="flex w-full items-center justify-between rounded-[1.25rem] border border-slate-200 bg-white px-4 py-4 text-left text-slate-800"
              >
                <span className="flex items-center gap-3 font-semibold">
                  <Copy className="h-5 w-5 text-sky-700" />
                  Copy GPS coordinates
                </span>
                <span className="text-xs uppercase tracking-[0.18em] text-slate-500">
                  {copyState || `${navigatorItem.lat}, ${navigatorItem.lng}`}
                </span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
