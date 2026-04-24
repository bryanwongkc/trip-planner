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
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  Cloud,
  CloudRain,
  Pencil,
  Footprints,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Sun,
  Trash2,
  X,
  CarFront,
  GripVertical,
  TrainFront,
} from 'lucide-react'
import {
  CATEGORY_OPTIONS,
  DEFAULT_TRIP_TITLE,
  MAPS_API_KEY,
  SEED_DAYS,
  TRIP_ID,
} from './data/seedItinerary'
import {
  createTripRecord,
  ensureAnonymousAuth,
  firebaseEnabled,
  mergeTripPatch,
  subscribeToTripDirectory,
  subscribeToTripState,
  upsertTripMeta,
} from './services/firebase'
import {
  extractFlightNumber,
  fetchFlightStatusByNumber,
  inferFlightLookupFromItem,
} from './services/aerodatabox'
import { fetchWeatherSnapshot } from './services/weather'
import {
  DAY_VIEW_ALL,
  buildDayLabel,
  compareTime,
  deriveEndTimeFromDuration,
  deriveTripState,
  formatDayDate,
  formatFullDayDate,
  getDurationMinutes,
  movementItemsForDay,
  nextDayDate,
  normalizeDayTimelineOrder,
  normalizeItemTimeFields,
  reorderTripItems,
  renumberDays,
  slugId,
} from './utils/trip'

const LONG_PRESS_MS = 600
const MOVE_THRESHOLD = 10
const DROP_DAY_SWITCH_MS = 240
const ACTIVE_TRIP_STORAGE_KEY = 'trip-planner-active-trip'
const TripMap = lazy(() => import('./components/TripMap'))
const TRAVEL_MODE_OPTIONS = [
  { value: 'driving', label: 'Car' },
  { value: 'transit', label: 'Public transport' },
  { value: 'walking', label: 'Walking' },
]
const ROUTE_MODE_OPTIONS = [
  { value: '', label: 'Auto' },
  ...TRAVEL_MODE_OPTIONS,
]
const DURATION_PRESETS = [
  { label: '30m', value: 30 },
  { label: '45m', value: 45 },
  { label: '1h', value: 60 },
  { label: '1h30', value: 90 },
  { label: '2h', value: 120 },
  { label: '3h', value: 180 },
]

function useResponsiveMode() {
  const [isMobilePortrait, setIsMobilePortrait] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(max-width: 900px)').matches,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const media = window.matchMedia('(max-width: 900px)')
    const update = () => setIsMobilePortrait(media.matches)

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

function useGoogleMapsApi(apiKey) {
  const [loaded, setLoaded] = useState(Boolean(apiKey && window.google?.maps?.places))
  const [error, setError] = useState('')
  const ready = Boolean(apiKey && (loaded || window.google?.maps?.places))

  useEffect(() => {
    if (!apiKey || window.google?.maps?.places) return undefined

    const existing = document.querySelector('script[data-google-maps-loader="trip-planner"]')
    if (existing) {
      const handleLoad = () => {
        setLoaded(true)
        setError('')
      }
      const handleError = () => setError('Google Maps failed to load')
      existing.addEventListener('load', handleLoad)
      existing.addEventListener('error', handleError)
      return () => {
        existing.removeEventListener('load', handleLoad)
        existing.removeEventListener('error', handleError)
      }
    }

    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`
    script.async = true
    script.defer = true
    script.dataset.googleMapsLoader = 'trip-planner'
    script.addEventListener('load', () => {
      setLoaded(true)
      setError('')
    })
    script.addEventListener('error', () => setError('Google Maps failed to load'))
    document.head.appendChild(script)

    return () => {
      script.removeEventListener('load', () => {})
      script.removeEventListener('error', () => {})
    }
  }, [apiKey])

  return { ready, error }
}

function typeMeta(category) {
  if (category === 'Flight') return { tone: 'bg-sky-50 text-sky-600' }
  if (category === 'Car') return { tone: 'bg-indigo-50 text-indigo-600' }
  if (category === 'Hotel') return { tone: 'bg-amber-50 text-amber-600' }
  if (category === 'Wedding') return { tone: 'bg-pink-50 text-pink-600' }
  return { tone: 'bg-emerald-50 text-emerald-600' }
}

function routeLabel(mode) {
  if (mode === 'transit') return 'Transit'
  return mode === 'walking' ? 'Walk' : 'Drive'
}

function RouteModeControl({ currentMode, onSelect }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const activeOption = ROUTE_MODE_OPTIONS.find((option) => option.value === (currentMode || '')) || ROUTE_MODE_OPTIONS[0]

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-1.5 rounded-full bg-white/96 px-2.5 py-1.5 text-[10px] font-semibold tracking-[-0.01em] text-slate-600 transition hover:bg-white"
      >
        <span>{activeOption.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="absolute right-0 top-[calc(100%+0.45rem)] z-20 min-w-[9.5rem] rounded-[0.9rem] border border-slate-200/90 bg-white/98 p-1.5 shadow-[0_14px_28px_rgba(15,23,42,0.07)]">
          {ROUTE_MODE_OPTIONS.map((option) => {
            const active = (currentMode || '') === option.value
            return (
              <button
                key={option.value || 'auto'}
                type="button"
                onClick={() => {
                  onSelect(option.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between rounded-[0.75rem] px-2.5 py-2 text-left text-[11px] font-medium tracking-[-0.01em] transition ${
                  active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span>{option.label}</span>
                {active ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function getWeatherDisplay(activeDayId, weatherState, selectedWeather) {
  if (activeDayId === DAY_VIEW_ALL) return null

  if (weatherState.loading) {
    return {
      headline: 'Loading weather',
      detail: 'Checking the Open-Meteo forecast for this day.',
      icon: Cloud,
      compact: 'Loading weather',
    }
  }

  if (weatherState.error) {
    return {
      headline: weatherState.error,
      detail: 'Live weather could not be loaded right now.',
      icon: Cloud,
      compact: weatherState.error,
    }
  }

  if (selectedWeather) {
    return {
      headline: `${Math.round(selectedWeather.tempMax)}° · Rain ${selectedWeather.rainProbability ?? 0}%`,
      detail: selectedWeather.label,
      icon: selectedWeather.rainProbability >= 40 ? CloudRain : Sun,
      compact: `${Math.round(selectedWeather.tempMax)} deg, ${selectedWeather.label}`,
    }
  }

  const availableDates = weatherState.data?.availableDates || []
  const firstAvailable = availableDates[0]
  const lastAvailable = availableDates[availableDates.length - 1]

  return {
    headline: 'Forecast not available yet',
    detail:
      firstAvailable && lastAvailable
        ? `Live forecast currently covers ${formatFullDayDate(firstAvailable)} to ${formatFullDayDate(lastAvailable)}.`
        : 'Live forecast is not available for this date yet.',
    icon: Cloud,
    compact: 'Forecast not available yet',
  }
}

function buildEmptyDraft(dayId = '') {
  return {
    id: '',
    dayId,
    category: 'Activity',
    title: '',
    flightCode: '',
    locationName: '',
    address: '',
    startTime: '10:00',
    endTime: '11:00',
    endTimeMode: 'time',
    durationMinutes: null,
    description: '',
    bookingRef: '',
    travelModeToNext: '',
    flightInfo: null,
    lat: null,
    lng: null,
    placeId: '',
  }
}

function buildDefaultTripSummary() {
  return {
    id: TRIP_ID,
    title: DEFAULT_TRIP_TITLE,
    startDate: SEED_DAYS[0]?.date || '',
    endDate: SEED_DAYS[SEED_DAYS.length - 1]?.date || '',
  }
}

function formatTripDateRange(startDate, endDate) {
  if (!startDate && !endDate) return 'No dates'
  if (startDate && endDate && startDate !== endDate) {
    return `${formatDayDate(startDate)} to ${formatDayDate(endDate)}`
  }
  return formatDayDate(startDate || endDate)
}

function serializeTripState(tripState) {
  return {
    days: Object.fromEntries(
      tripState.days.map((day) => [
        day.id,
        {
          id: day.id,
          date: day.date,
          name: day.name || '',
          order: day.order,
        },
      ]),
    ),
    items: Object.fromEntries(
      tripState.items
        .filter((item) => !item.generated)
        .map((item) => [
          item.id,
          {
            id: item.id,
            dayId: item.dayId,
            order: item.order,
            title: item.title,
            flightCode: item.flightCode || '',
            locationName: item.locationName,
            address: item.address,
            category: item.category,
            startTime: item.startTime,
            endTime: item.endTime,
            endTimeMode: item.endTimeMode || 'time',
            durationMinutes: Number.isFinite(Number(item.durationMinutes))
              ? Number(item.durationMinutes)
              : null,
            description: item.description,
            bookingRef: item.bookingRef,
            travelModeToNext: item.travelModeToNext || '',
            flightInfo: item.flightInfo || null,
            lat: item.lat,
            lng: item.lng,
            placeId: item.placeId,
          },
        ]),
    ),
  }
}

function generatedItemPatch(item) {
  return {
    id: item.id,
    dayId: item.dayId,
    flightCode: item.flightCode || '',
    startTime: item.startTime,
    endTime: item.endTime,
    endTimeMode: item.endTimeMode || 'time',
    durationMinutes: Number.isFinite(Number(item.durationMinutes))
      ? Number(item.durationMinutes)
      : null,
    description: item.description,
    bookingRef: item.bookingRef,
    travelModeToNext: item.travelModeToNext || '',
    flightInfo: item.flightInfo || null,
  }
}

function toLocalDateInput(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

function isCurrentDate(date) {
  if (!date) return false
  return date === toLocalDateInput(new Date())
}

function formatLocalTimeToClock(value) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function buildFlightLookupKey(flightCode, date) {
  if (!flightCode || !date) return ''
  return `${flightCode.trim().toUpperCase()}|${date}`
}

function airportCodeLabel(code, name) {
  if (code && name) return `${code} · ${name}`
  return code || name || ''
}

function buildFlightTitle(record, flightCode) {
  const departureCode = record?.departureAirport || 'DEP'
  const arrivalCode = record?.arrivalAirport || 'ARR'
  return `Flight ${departureCode} to ${arrivalCode} (${flightCode})`
}

function buildFlightInfoBlock(record) {
  const lines = [
    airportCodeLabel(record.departureAirport, record.departureAirportName)
      ? `Departure: ${airportCodeLabel(record.departureAirport, record.departureAirportName)}`
      : '',
    record.departureTerminal ? `Departure terminal: ${record.departureTerminal}` : '',
    record.departureGate ? `Departure gate: ${record.departureGate}` : '',
    airportCodeLabel(record.arrivalAirport, record.arrivalAirportName)
      ? `Arrival: ${airportCodeLabel(record.arrivalAirport, record.arrivalAirportName)}`
      : '',
    record.arrivalTerminal ? `Arrival terminal: ${record.arrivalTerminal}` : '',
    record.arrivalGate ? `Arrival gate: ${record.arrivalGate}` : '',
    record.aircraftModel ? `Aircraft: ${record.aircraftModel}` : '',
  ].filter(Boolean)

  if (!lines.length) return ''
  return `\n\n${lines.join('\n')}`
}

function mergeFlightInfoIntoDescription(description, record) {
  const base = String(description || '')
    .replace(/\n?\n?(?:\[Flight details\]\n)?Departure:[\s\S]*$/u, '')
    .trimEnd()
  const block = buildFlightInfoBlock(record)
  return block ? `${base}${block}`.trim() : base
}

function applyFlightRecordToDraft(item, record, flightCode, lookupKey) {
  const departureLabel = airportCodeLabel(record.departureAirport, record.departureAirportName)
  const arrivalLabel = airportCodeLabel(record.arrivalAirport, record.arrivalAirportName)
  const departureLat =
    typeof record.departureAirportLocation?.lat === 'number' ? record.departureAirportLocation.lat : item.lat
  const departureLng =
    typeof record.departureAirportLocation?.lng === 'number' ? record.departureAirportLocation.lng : item.lng

  return {
    ...item,
    category: 'Flight',
    flightCode,
    title: buildFlightTitle(record, flightCode),
    locationName: departureLabel && arrivalLabel ? `${departureLabel} → ${arrivalLabel}` : item.locationName,
    address: [departureLabel, arrivalLabel].filter(Boolean).join(' → ') || item.address,
    startTime: formatLocalTimeToClock(record.scheduledDeparture) || item.startTime,
    endTime: formatLocalTimeToClock(record.scheduledArrival) || item.endTime,
    lat: departureLat,
    lng: departureLng,
    description: mergeFlightInfoIntoDescription(item.description, record),
    flightInfo: {
      number: record.number || flightCode,
      departureAirport: record.departureAirport || '',
      departureAirportName: record.departureAirportName || '',
      departureAirportLocation: record.departureAirportLocation || null,
      departureTerminal: record.departureTerminal || '',
      departureGate: record.departureGate || '',
      arrivalAirport: record.arrivalAirport || '',
      arrivalAirportName: record.arrivalAirportName || '',
      arrivalAirportLocation: record.arrivalAirportLocation || null,
      arrivalTerminal: record.arrivalTerminal || '',
      arrivalGate: record.arrivalGate || '',
      aircraftModel: record.aircraftModel || '',
      scheduledDeparture: record.scheduledDeparture || '',
      scheduledArrival: record.scheduledArrival || '',
      lookupKey: lookupKey || '',
      fetchedAt: new Date().toISOString(),
    },
  }
}

function hasAppliedFlightLookup(item, lookupKey) {
  return Boolean(item?.flightInfo?.lookupKey && item.flightInfo.lookupKey === lookupKey)
}

function selectFlightRecord(records, flightCode) {
  const normalizedCode = extractFlightNumber(flightCode)
  if (!normalizedCode) return records?.[0] || null

  return (
    records.find((record) => extractFlightNumber(record.number || '') === normalizedCode) ||
    records[0] ||
    null
  )
}

function getFlightAnchor(item, mode) {
  const info = item?.flightInfo
  if (!info) return null

  const location =
    mode === 'departure' ? info.departureAirportLocation : info.arrivalAirportLocation

  if (typeof location?.lat !== 'number' || typeof location?.lng !== 'number') {
    return null
  }

  return {
    lat: location.lat,
    lng: location.lng,
  }
}

function normalizeAirportText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function itemMatchesAirport(item, airportCode, airportName) {
  if (!item || typeof item.lat !== 'number' || typeof item.lng !== 'number') return false

  const haystack = normalizeAirportText(`${item.title} ${item.locationName} ${item.address}`)
  const code = normalizeAirportText(airportCode)
  const name = normalizeAirportText(airportName)

  if (code && haystack.includes(code)) return true

  if (!name) return false

  const tokens = name
    .split(' ')
    .filter(
      (token) =>
        token.length > 2 &&
        !['airport', 'international', 'terminal', 'city'].includes(token),
    )

  if (!tokens.length) return false

  return tokens.every((token) => haystack.includes(token))
}

function getResolvedFlightAnchor(item, mode, adjacentItem) {
  const info = item?.flightInfo
  const anchor = getFlightAnchor(item, mode)

  if (!info) return anchor

  const airportCode = mode === 'departure' ? info.departureAirport : info.arrivalAirport
  const airportName = mode === 'departure' ? info.departureAirportName : info.arrivalAirportName

  if (itemMatchesAirport(adjacentItem, airportCode, airportName)) {
    return {
      lat: adjacentItem.lat,
      lng: adjacentItem.lng,
    }
  }

  return anchor
}

function resolveTravelPoint(item, direction, adjacentItem = null) {
  if (!item) return null
  if (item.category === 'Flight') {
    const anchor = getResolvedFlightAnchor(
      item,
      direction === 'outbound' ? 'arrival' : 'departure',
      adjacentItem,
    )
    if (anchor) {
      return {
        ...item,
        lat: anchor.lat,
        lng: anchor.lng,
      }
    }
  }

  if (typeof item.lat === 'number' && typeof item.lng === 'number') {
    return item
  }

  return null
}

function assignItemOrder(items) {
  const normalizedItems = items.map((item) => normalizeItemTimeFields(item))
  return normalizeDayTimelineOrder(normalizedItems, normalizedItems[0]?.dayId || '')
}

function mergeItemsForDay(currentItems, nextItem) {
  const mergedItems = [...currentItems.filter((item) => item.id !== nextItem.id), normalizeItemTimeFields(nextItem)]
  return normalizeDayTimelineOrder(mergedItems, nextItem.dayId)
}

function createItemDraft(item) {
  const normalized = normalizeItemTimeFields(item)
  return {
    ...normalized,
    durationMinutes:
      normalized.endTimeMode === 'duration'
        ? normalized.durationMinutes ?? getDurationMinutes(normalized.startTime, normalized.endTime)
        : normalized.durationMinutes,
  }
}

function applyItemDraftPatch(item, patch) {
  const nextItem = { ...item, ...patch }

  if (Object.prototype.hasOwnProperty.call(patch, 'endTimeMode') && patch.endTimeMode === 'duration') {
    const derivedDuration =
      nextItem.durationMinutes ?? getDurationMinutes(nextItem.startTime, nextItem.endTime)

    return normalizeItemTimeFields({
      ...nextItem,
      endTimeMode: 'duration',
      durationMinutes: derivedDuration,
    })
  }

  return normalizeItemTimeFields(nextItem)
}

function getEndTimeWarning(item) {
  if (!item?.startTime || !item?.endTime) return ''
  return compareTime(item.endTime, item.startTime) < 0
    ? 'End time is earlier than start time. For overnight items, split into two items.'
    : ''
}

function getScheduleConflictMeta(items) {
  const orderedItems = assignItemOrder(items)

  for (let index = 0; index < orderedItems.length - 1; index += 1) {
    const current = orderedItems[index]
    const next = orderedItems[index + 1]
    if (!current.endTime || !next.startTime) continue
    if (compareTime(current.endTime, next.startTime) > 0) {
      return {
        currentId: current.id,
        nextId: next.id,
        message: `${current.title} ends after ${next.title} starts.`,
      }
    }
  }

  return null
}

function makeMovementPairs(items) {
  return items
    .slice(0, -1)
    .map((item, index) => [
      resolveTravelPoint(item, 'outbound', items[index + 1]),
      resolveTravelPoint(items[index + 1], 'inbound', item),
      item,
      items[index + 1],
    ])
    .filter(([fromPoint, toPoint]) => typeof fromPoint?.lat === 'number' && typeof toPoint?.lat === 'number')
    .map(([fromPoint, toPoint, fromItem, toItem]) => [fromPoint, toPoint, fromItem, toItem])
}

function buildMapItems(items) {
  return items
    .map((item, index) => {
      const previousItem = items[index - 1] || null
      const nextItem = items[index + 1] || null

      if (item.category === 'Flight') {
        if (nextItem) return resolveTravelPoint(item, 'outbound', nextItem)
        if (previousItem) return resolveTravelPoint(item, 'inbound', previousItem)
      }

      return resolveTravelPoint(item, 'outbound', nextItem)
    })
    .filter(Boolean)
}

function getRouteMode(from, to) {
  if (from.travelModeToNext) return from.travelModeToNext
  const latDiff = (to.lat - from.lat) * 111
  const lngDiff = (to.lng - from.lng) * 91
  const km = Math.sqrt(latDiff ** 2 + lngDiff ** 2)
  return km <= 1.5 ? 'walking' : 'driving'
}

function estimateDistanceKm(from, to) {
  const latDiff = (to.lat - from.lat) * 111
  const lngDiff = (to.lng - from.lng) * 91
  return Math.sqrt(latDiff ** 2 + lngDiff ** 2)
}

function toRouteSummary(result, mode) {
  const route = result.routes?.[0]
  const leg = route?.legs?.[0]
  if (!route || !leg) return null

  return {
    mode,
    distanceKm: (leg.distance?.value || 0) / 1000,
    durationMin: (leg.duration?.value || 0) / 60,
    path: route.overview_path?.map((point) => ({ lat: point.lat(), lng: point.lng() })) || [],
  }
}

function buildFallbackRouteSummary(from, to, mode) {
  const distanceKm = estimateDistanceKm(from, to)
  const speedKmPerHour = mode === 'walking' ? 4.5 : mode === 'transit' ? 22 : 32

  return {
    mode,
    distanceKm,
    durationMin: (distanceKm / speedKmPerHour) * 60,
    path: [
      { lat: from.lat, lng: from.lng },
      { lat: to.lat, lng: to.lng },
    ],
    estimated: true,
  }
}

function getWeatherTarget(items) {
  const locatedItems = items.filter(
    (item) => typeof item?.lat === 'number' && typeof item?.lng === 'number',
  )

  if (!locatedItems.length) return null

  const total = locatedItems.reduce(
    (sum, item) => ({
      lat: sum.lat + item.lat,
      lng: sum.lng + item.lng,
    }),
    { lat: 0, lng: 0 },
  )

  return {
    lat: total.lat / locatedItems.length,
    lng: total.lng / locatedItems.length,
  }
}

async function requestDirectionsRoute(from, to, mode) {
  const directionsService = new window.google.maps.DirectionsService()

  return new Promise((resolve, reject) => {
    directionsService.route(
      {
        origin: { lat: from.lat, lng: from.lng },
        destination: { lat: to.lat, lng: to.lng },
        travelMode:
          mode === 'walking'
            ? window.google.maps.TravelMode.WALKING
            : mode === 'transit'
              ? window.google.maps.TravelMode.TRANSIT
              : window.google.maps.TravelMode.DRIVING,
      },
      (response, status) => {
        if (status === 'OK' && response) {
          resolve(response)
          return
        }
        reject(new Error(`Route failed: ${status}`))
      },
    )
  })
}

function GooglePlaceField({
  disabled,
  mapsReady,
  onSelect,
  onValueChange,
  selectedPlaceId,
  value,
}) {
  const [predictions, setPredictions] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const autocompleteRef = useRef(null)
  const placesRef = useRef(null)
  const tokenRef = useRef(null)
  const selectedLabelRef = useRef('')

  useEffect(() => {
    if (!mapsReady || !window.google?.maps?.places) return
    autocompleteRef.current = new window.google.maps.places.AutocompleteService()
    placesRef.current = new window.google.maps.places.PlacesService(document.createElement('div'))
    tokenRef.current = new window.google.maps.places.AutocompleteSessionToken()
  }, [mapsReady])

  useEffect(() => {
    if (selectedPlaceId && value.trim()) {
      selectedLabelRef.current = value.trim()
      return
    }

    selectedLabelRef.current = ''
  }, [selectedPlaceId, value])

  useEffect(() => {
    if (!mapsReady || disabled || !value.trim() || !autocompleteRef.current) {
      setPredictions([])
      setSearching(false)
      return undefined
    }

    if (selectedLabelRef.current && value.trim() === selectedLabelRef.current) {
      setPredictions([])
      setSearching(false)
      return undefined
    }

    let cancelled = false
    setSearching(true)
    setError('')

    const timer = window.setTimeout(() => {
      autocompleteRef.current.getPlacePredictions(
        {
          input: value,
          sessionToken: tokenRef.current,
        },
        (results, status) => {
          if (cancelled) return
          setSearching(false)
          if (
            status === window.google.maps.places.PlacesServiceStatus.ZERO_RESULTS ||
            !results?.length
          ) {
            setPredictions([])
            return
          }
          if (status !== window.google.maps.places.PlacesServiceStatus.OK) {
            setPredictions([])
            setError('Google place search failed')
            return
          }
          setPredictions(results.slice(0, 5))
        },
      )
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [disabled, mapsReady, value])

  function selectPrediction(prediction) {
    if (!placesRef.current || !window.google?.maps?.places) return

    placesRef.current.getDetails(
      {
        placeId: prediction.place_id,
        fields: ['place_id', 'name', 'formatted_address', 'geometry'],
        sessionToken: tokenRef.current,
      },
      (place, status) => {
        if (status !== window.google.maps.places.PlacesServiceStatus.OK || !place) {
          setError('Unable to load place details')
          return
        }

        const resolvedLabel =
          place.name || prediction.structured_formatting?.main_text || value
        tokenRef.current = new window.google.maps.places.AutocompleteSessionToken()
        selectedLabelRef.current = resolvedLabel.trim()
        setPredictions([])
        setSearching(false)
        onSelect({
          placeId: place.place_id || '',
          locationName: resolvedLabel,
          address: place.formatted_address || prediction.description || '',
          lat: place.geometry?.location?.lat?.() ?? null,
          lng: place.geometry?.location?.lng?.() ?? null,
        })
      },
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => {
            selectedLabelRef.current = ''
            onValueChange(event.target.value)
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setPredictions([])
            }, 120)
          }}
          disabled={disabled || !mapsReady}
          placeholder="Search with Google Maps"
          className="w-full min-w-0 rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-[14px] text-slate-900 disabled:bg-slate-100"
        />
        <div className="flex w-11 items-center justify-center rounded-[1.1rem] bg-slate-900 text-white">
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </div>
      </div>

      <div className="text-[11px] leading-5 text-slate-500">
        Select a Google Places suggestion to attach a reliable map pin.
      </div>

      {error ? (
        <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>
      ) : null}

      {predictions.length ? (
        <div className="space-y-1.5 rounded-[1.15rem] bg-slate-50/90 p-2">
          {predictions.map((prediction) => (
            <button
              key={prediction.place_id}
              type="button"
              onClick={() => selectPrediction(prediction)}
              className="block w-full rounded-[1rem] bg-white px-3.5 py-3 text-left transition hover:bg-slate-50"
            >
              <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
                {prediction.structured_formatting?.main_text || prediction.description}
              </div>
              <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-500">
                {prediction.structured_formatting?.secondary_text || prediction.description}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PlaceFields({ draft, disabled, mapsReady, onChange }) {
  return (
    <div className="space-y-3">
      <Field label="Location search">
        <GooglePlaceField
          disabled={disabled}
          mapsReady={mapsReady}
          selectedPlaceId={draft.placeId}
          value={draft.locationName}
          onValueChange={(value) =>
            onChange({
              locationName: value,
              placeId: '',
              lat: null,
              lng: null,
            })
          }
          onSelect={onChange}
        />
      </Field>

      <Field label="Address">
        <input
          value={draft.address}
          onChange={(event) => onChange({ address: event.target.value })}
          disabled={disabled}
          className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
        />
      </Field>
    </div>
  )
}

function Field({ label, children, className = '' }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  )
}

function TimeField({ conflict, disabled, label, onChange, value }) {
  return (
    <label className="block">
      <span
        className={`mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] ${
          conflict ? 'font-bold text-rose-600' : 'text-slate-500'
        }`}
      >
        {conflict ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
        {label}
      </span>
      <input
        type="time"
        value={value}
        onChange={onChange}
        disabled={disabled}
        className={`w-full rounded-[1.15rem] border bg-white px-4 py-3 text-[14px] tracking-[-0.01em] disabled:bg-slate-100 ${
          conflict
            ? 'border-rose-300 font-bold text-rose-700 ring-1 ring-rose-200'
            : 'border-slate-200/90'
        }`}
      />
    </label>
  )
}

function EndTimeModeField({ conflict = false, disabled, draft, onChange }) {
  const derivedEndTime =
    draft.endTimeMode === 'duration'
      ? deriveEndTimeFromDuration(draft.startTime, draft.durationMinutes)
      : draft.endTime

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ endTimeMode: 'time' })}
          className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
            draft.endTimeMode === 'time'
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-600'
          } disabled:bg-slate-100 disabled:text-slate-400`}
        >
          End time
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange({
              endTimeMode: 'duration',
              durationMinutes:
                draft.durationMinutes ?? getDurationMinutes(draft.startTime, draft.endTime) ?? 60,
            })
          }
          className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
            draft.endTimeMode === 'duration'
              ? 'bg-slate-900 text-white'
              : 'bg-slate-100 text-slate-600'
          } disabled:bg-slate-100 disabled:text-slate-400`}
        >
          Duration
        </button>
      </div>

      {draft.endTimeMode === 'time' ? (
        <TimeField
          label="End time"
          value={draft.endTime}
          onChange={(event) => onChange({ endTime: event.target.value })}
          disabled={disabled}
          conflict={conflict}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Duration">
            <input
              type="number"
              min="0"
              step="5"
              value={draft.durationMinutes ?? ''}
              onChange={(event) =>
                onChange({
                  durationMinutes: event.target.value === '' ? null : Number(event.target.value),
                })
              }
              disabled={disabled}
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-[14px] tracking-[-0.01em] disabled:bg-slate-100"
            />
          </Field>
          <Field label="Derived end">
            <div className="w-full rounded-[1.15rem] border border-slate-200/90 bg-slate-50 px-4 py-3 text-[14px] font-semibold tracking-[-0.01em] text-slate-700">
              {derivedEndTime || '--:--'}
            </div>
          </Field>
          <div className="sm:col-span-2">
            <div className="text-[11px] leading-5 text-slate-500">
              Use duration when you know how long the stop takes. The app will calculate the end time.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {DURATION_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ durationMinutes: preset.value })}
                  className={`rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
                    Number(draft.durationMinutes) === preset.value
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600'
                  } disabled:bg-slate-100 disabled:text-slate-400`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TripSwitcher({
  activeTripId,
  deletedTrips,
  disabled,
  isMobilePortrait,
  onCreateTrip,
  onDeleteTrip,
  onRenameTrip,
  onRestoreTrip,
  onSelectTrip,
  tripSummaries,
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const activeTrip = tripSummaries.find((trip) => trip.id === activeTripId) || tripSummaries[0]

  useEffect(() => {
    if (!open) return undefined

    function handlePointerDown(event) {
      if (!containerRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }

    function handleEscape(event) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  function handleSelectTrip(tripId) {
    onSelectTrip(tripId)
    setOpen(false)
  }

  async function handleCreateTrip() {
    setOpen(false)
    await onCreateTrip()
  }

  return (
    <div
      ref={containerRef}
      className="relative z-40 isolate rounded-[1rem] border border-white/70 bg-[rgba(255,252,247,0.96)] px-2.5 py-1.5 shadow-[0_10px_24px_rgba(35,56,64,0.03)] sm:px-3 sm:py-2"
    >
      <div className="mb-0.5 flex items-center justify-between gap-3 px-0.5">
        <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-slate-400">Trips</div>
        <div className="text-[9px] font-medium text-slate-400">{tripSummaries.length}</div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || !activeTrip}
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2.5 rounded-[0.9rem] border border-slate-200/90 bg-white text-left text-slate-900 transition hover:border-slate-300 ${
          isMobilePortrait ? 'px-2.5 py-2' : 'px-3 py-2.5'
        } disabled:bg-slate-100`}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900 sm:text-[14px]">
            {activeTrip?.title || 'Select trip'}
          </div>
          <div className="truncate pt-0.5 text-[9px] font-medium text-slate-500 sm:text-[10px]">
            {activeTrip ? formatTripDateRange(activeTrip.startDate, activeTrip.endDate) : 'No trip'}
          </div>
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <ChevronDown className={`h-3.5 w-3.5 transition ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {open ? (
        <div className="absolute inset-x-0 top-[calc(100%+0.55rem)] z-50">
          <div className="overflow-hidden rounded-[1rem] border border-slate-200/90 bg-[rgba(255,253,250,0.99)] p-1.5 shadow-[0_18px_38px_rgba(15,23,42,0.08)] backdrop-blur-sm">
            <div className="no-scrollbar max-h-[min(24rem,56svh)] overflow-y-auto pr-0.5">
              {tripSummaries.map((trip) => {
                const selected = trip.id === activeTripId
                return (
                  <button
                    key={trip.id}
                    type="button"
                    onClick={() => handleSelectTrip(trip.id)}
                    className={`flex w-full items-center gap-3 rounded-[0.9rem] px-3 py-2.5 text-left transition ${
                      selected ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-white/80'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold tracking-[-0.01em]">{trip.title}</div>
                      <div
                        className={`truncate pt-0.5 text-[11px] ${
                          selected ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {formatTripDateRange(trip.startDate, trip.endDate)}
                      </div>
                    </div>
                    <div
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                        selected ? 'bg-white/12 text-white' : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {selected ? <Check className="h-4 w-4" /> : <CalendarDays className="h-3.5 w-3.5" />}
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="mt-1 border-t border-slate-200/70 pt-1">
              <div className="grid grid-cols-2 gap-1 px-1 pb-1">
                <button
                  type="button"
                  onClick={() => void onRenameTrip()}
                  disabled={disabled || !activeTrip}
                  className="flex items-center justify-center gap-2 rounded-[0.8rem] px-3 py-2 text-[12px] font-semibold text-slate-600 transition hover:bg-white/80 disabled:text-slate-400"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteTrip()}
                  disabled={disabled || !activeTrip || activeTrip.id === TRIP_ID}
                  className="flex items-center justify-center gap-2 rounded-[0.8rem] px-3 py-2 text-[12px] font-semibold text-rose-600 transition hover:bg-rose-50 disabled:text-slate-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
              {deletedTrips.length ? (
                <div className="border-t border-slate-200/70 px-1 pt-1.5">
                  <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Recently deleted
                  </div>
                  <div className="space-y-1 pb-1">
                    {deletedTrips.map((trip) => (
                      <button
                        key={trip.id}
                        type="button"
                        onClick={() => void onRestoreTrip(trip.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-[0.8rem] px-3 py-2 text-left text-slate-600 transition hover:bg-white/80"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-semibold text-slate-700">{trip.title}</div>
                          <div className="truncate pt-0.5 text-[10px] text-slate-500">
                            {formatTripDateRange(trip.startDate, trip.endDate)}
                          </div>
                        </div>
                        <div className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-600">
                          Restore
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => void handleCreateTrip()}
                disabled={disabled}
                className="flex w-full items-center justify-between gap-3 rounded-[0.9rem] px-3 py-2.5 text-left text-slate-700 transition hover:bg-white/80 disabled:text-slate-400"
              >
                <div>
                  <div className="text-[13px] font-semibold tracking-[-0.01em]">New trip</div>
                  <div className="pt-0.5 text-[11px] text-slate-500">Create a separate itinerary workspace.</div>
                </div>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
                  <Plus className="h-4 w-4" />
                </div>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function DayManagerModal({
  activeDayId,
  days,
  firestoreReady,
  isMobilePortrait,
  onAddDay,
  onClose,
  onDeleteDay,
  onMoveDay,
  onUpdateDay,
}) {
  const [newDay, setNewDay] = useState({
    date: nextDayDate(days),
    name: '',
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 pt-10 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`glass-panel w-full max-h-[82svh] overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
          isMobilePortrait ? 'rounded-[1.55rem] sm:max-w-md' : 'max-w-3xl rounded-[1.8rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[1.7rem] font-bold tracking-[-0.02em] text-slate-900">Manage days</h3>
            <p className="mt-1 text-[13px] text-slate-600">
              Reorder, rename, edit dates, add, or delete trip days.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          {days.map((day, index) => (
            <div
              key={day.id}
              className={`rounded-[1.3rem] bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.03)] ${
                day.id === activeDayId ? 'ring-2 ring-indigo-200' : ''
              }`}
            >
              <div className="grid gap-3 sm:grid-cols-[1.2fr_1fr_auto] sm:items-end">
                <Field label={`Day ${index + 1}`}>
                  <input
                    value={day.name || ''}
                    onChange={(event) => onUpdateDay(day.id, { name: event.target.value })}
                    disabled={!firestoreReady}
                    placeholder="Optional label"
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
                  />
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    value={day.date}
                    onChange={(event) => onUpdateDay(day.id, { date: event.target.value })}
                    disabled={!firestoreReady}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
                  />
                </Field>
                <div className="flex items-center gap-2 pb-0.5 sm:justify-end">
                  <button
                    type="button"
                    onClick={() => onMoveDay(day.id, -1)}
                    disabled={!firestoreReady || index === 0}
                    className="rounded-2xl bg-slate-100 p-3 text-slate-700 disabled:text-slate-300"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveDay(day.id, 1)}
                    disabled={!firestoreReady || index === days.length - 1}
                    className="rounded-2xl bg-slate-100 p-3 text-slate-700 disabled:text-slate-300"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteDay(day.id)}
                    disabled={!firestoreReady}
                    className="rounded-2xl bg-rose-50 p-3 text-rose-600 disabled:text-slate-300"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-2 text-[13px] text-slate-500">{buildDayLabel(day, index)}</div>
            </div>
          ))}
        </div>

        <div className="mt-5 rounded-[1.3rem] bg-slate-50/85 p-4">
          <div className="text-[13px] font-semibold tracking-[-0.01em] text-slate-900">Add day</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Date">
              <input
                type="date"
                value={newDay.date}
                onChange={(event) => setNewDay((current) => ({ ...current, date: event.target.value }))}
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
              />
            </Field>
            <Field label="Label">
              <input
                value={newDay.name}
                onChange={(event) => setNewDay((current) => ({ ...current, name: event.target.value }))}
                placeholder="Optional label"
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
              />
            </Field>
            <button
              type="button"
              onClick={() => onAddDay(newDay)}
              disabled={!firestoreReady}
              className="rounded-[1.2rem] bg-slate-900 px-4 py-3 text-sm font-bold text-white disabled:bg-slate-300"
            >
              Add day
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function NoteModal({ item, isMobilePortrait, onClose, onDelete, onOpenDetails }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 pt-10 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`glass-panel browse-ui w-full max-h-[78svh] overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
          isMobilePortrait ? 'rounded-[1.35rem] sm:max-w-md' : 'max-w-lg rounded-[1.65rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[1.45rem] font-bold tracking-[-0.025em] text-slate-900">{item.title}</h3>
            <p className="mt-1 text-[12px] leading-5 text-slate-600">{item.locationName || item.address}</p>
          </div>
          <div className="flex items-center gap-2">
            {!item.generated ? (
              <button
                type="button"
                onClick={() => void onDelete()}
                className="rounded-full bg-rose-50 p-2 text-rose-600"
                aria-label="Delete item"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="mt-3.5 space-y-2">
          <div className="rounded-[1rem] bg-white px-4 py-3.5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Notes</div>
            <div className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-slate-700">
              {item.generated
                ? 'This hotel stop stays linked to the previous day hotel. You can still adjust time, notes, and booking details here.'
                : item.description || 'No notes yet.'}
            </div>
          </div>
          {item.bookingRef ? (
            <div className="rounded-[1rem] bg-white px-4 py-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Booking ref</div>
              <div className="mt-2 text-[13px] font-semibold tracking-[-0.01em] text-slate-900">{item.bookingRef}</div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onOpenDetails}
          className="mt-3.5 w-full rounded-[0.95rem] bg-slate-900 px-4 py-3.5 text-sm font-bold text-white"
        >
          {item.generated ? 'View linked details' : 'Open details'}
        </button>
      </div>
    </div>
  )
}

function DetailModal({
  dayOptions,
  detailItem,
  endTimeWarning,
  firestoreReady,
  isGenerated,
  isMobilePortrait,
  mapsReady,
  onChange,
  onClose,
  onDelete,
  onSave,
  scheduleConflict,
}) {
  const fieldReadOnly = !firestoreReady
  const linkedLocked = isGenerated
  const effectiveFlightCode = detailItem.flightCode || extractFlightNumber(detailItem.title || '')
  const travelModeMeta = useMemo(() => {
    if (detailItem.travelModeToNext === 'driving') {
      return { label: 'Car to next stop', icon: CarFront }
    }
    if (detailItem.travelModeToNext === 'transit') {
      return { label: 'Public transport to next stop', icon: TrainFront }
    }
    if (detailItem.travelModeToNext === 'walking') {
      return { label: 'Walking to next stop', icon: Footprints }
    }
    return null
  }, [detailItem.travelModeToNext])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-3 pt-10 backdrop-blur-sm sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`glass-panel w-full max-h-[78svh] overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
          isMobilePortrait ? 'rounded-[1.35rem] sm:max-w-md' : 'max-w-xl rounded-[1.7rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[1.45rem] font-bold tracking-[-0.025em] text-slate-900">{detailItem.title}</h3>
            <div className="mt-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <Check className="h-3.5 w-3.5" />
              {isGenerated ? 'Linked hotel item' : 'Editing draft'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isGenerated ? (
              <button
                type="button"
                onClick={() => void onDelete()}
                disabled={!firestoreReady}
                className="rounded-full bg-rose-50 p-2 text-rose-600 disabled:bg-slate-100 disabled:text-slate-400"
                aria-label="Delete item"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {isGenerated ? (
          <div className="mt-4 rounded-[0.95rem] bg-amber-50/90 px-4 py-3 text-[13px] leading-6 text-amber-700">
            This stop stays linked to the previous day hotel for place continuity. You can still edit its time, notes, and booking reference here.
          </div>
        ) : null}

        {travelModeMeta ? (
          <div className="mt-4 flex items-center gap-2 rounded-[0.95rem] bg-slate-100/90 px-4 py-3 text-[13px] text-slate-600">
            <travelModeMeta.icon className="h-4 w-4 text-slate-500" />
            <span>{travelModeMeta.label}</span>
          </div>
        ) : null}

        <div className={`mt-3.5 grid gap-3.5 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
          <Field label="Day">
            <select
              value={detailItem.dayId}
              onChange={(event) => onChange({ dayId: event.target.value })}
              disabled={fieldReadOnly || linkedLocked}
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            >
              {dayOptions.map((day) => (
                <option key={day.id} value={day.id}>
                  {day.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              value={detailItem.category}
              onChange={(event) => onChange({ category: event.target.value })}
              disabled={fieldReadOnly || linkedLocked}
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label={detailItem.category === 'Flight' ? 'Flight code' : 'Title'}>
            <input
              value={detailItem.category === 'Flight' ? effectiveFlightCode : detailItem.title}
              onChange={(event) =>
                onChange(
                  detailItem.category === 'Flight'
                    ? { flightCode: event.target.value.toUpperCase().replace(/\s+/g, '') }
                    : { title: event.target.value },
                )
              }
              placeholder={detailItem.category === 'Flight' ? 'CX549' : ''}
              disabled={fieldReadOnly || linkedLocked}
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
          <TimeField
            label="Start time"
            value={detailItem.startTime}
            onChange={(event) => onChange({ startTime: event.target.value })}
            disabled={fieldReadOnly}
            conflict={Boolean(scheduleConflict?.nextId === detailItem.id)}
          />
          <EndTimeModeField
            disabled={fieldReadOnly}
            draft={detailItem}
            onChange={onChange}
            conflict={Boolean(scheduleConflict?.currentId === detailItem.id)}
          />
        </div>

        {endTimeWarning ? (
          <div className="mt-3 rounded-[0.95rem] bg-amber-50/90 px-4 py-3 text-[13px] leading-6 text-amber-700">
            {endTimeWarning}
          </div>
        ) : null}

        <div className="mt-3.5 space-y-3">
          {detailItem.category !== 'Flight' ? (
            <PlaceFields
              draft={detailItem}
              disabled={fieldReadOnly || linkedLocked}
              mapsReady={mapsReady}
              onChange={onChange}
            />
          ) : null}

          <Field label="Booking ref">
            <input
              value={detailItem.bookingRef || ''}
              onChange={(event) => onChange({ bookingRef: event.target.value })}
              disabled={fieldReadOnly}
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
          <Field label="Notes">
            <textarea
              rows={5}
              value={detailItem.description || ''}
              onChange={(event) => onChange({ description: event.target.value })}
              disabled={fieldReadOnly}
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
        </div>

        <a
          href={
            typeof detailItem.lat === 'number' && typeof detailItem.lng === 'number'
              ? `https://www.google.com/maps/search/?api=1&query=${detailItem.lat},${detailItem.lng}`
              : '#'
          }
          target="_blank"
          rel="noreferrer"
          className={`mt-3.5 flex items-center justify-between rounded-[1rem] px-4 py-3.5 text-sm font-bold ${
            typeof detailItem.lat === 'number' && typeof detailItem.lng === 'number'
              ? 'bg-indigo-600 text-white'
              : 'pointer-events-none bg-slate-100 text-slate-400'
          }`}
        >
          Open in Google Maps
          <ExternalLink className="h-4 w-4" />
        </a>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm font-semibold text-slate-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!firestoreReady}
            className="rounded-[1rem] bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:bg-slate-300"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function PlannerPanel({
  activeDayId,
  dayOptions,
  dayMap,
  dragState,
  filteredItems,
  firestoreReady,
  getFlightRecord,
  isMobilePortrait,
  mapsReady,
  onDayChange,
  onDragStart,
  onManageDays,
  onOpenDetails,
  onOpenNotes,
  onSaveNewItem,
  onUpdateTravelMode,
  routeSegments,
  selectedWeather,
  weatherState,
}) {
  const weatherDisplay = getWeatherDisplay(activeDayId, weatherState, selectedWeather)
  const defaultDayId =
    activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)
      ? activeDayId
      : dayOptions[0]?.id || ''
  const [draft, setDraft] = useState(() => buildEmptyDraft(defaultDayId))
  const draftConflictId = '__draft__'
  const effectiveDraftDayId =
    activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)
      ? activeDayId
      : draft.dayId && dayOptions.some((day) => day.id === draft.dayId)
        ? draft.dayId
        : dayOptions[0]?.id || ''
  const [isComposerOpen, setIsComposerOpen] = useState(activeDayId !== DAY_VIEW_ALL)
  const draftFlightCode = draft.flightCode || extractFlightNumber(draft.title || '')
  const draftDayDate = dayMap[effectiveDraftDayId]?.date || ''
  const draftAppliedLookupKey = draft.flightInfo?.lookupKey || ''
  const draftFlightLookup = inferFlightLookupFromItem({
    ...draft,
    flightCode: draftFlightCode,
    dayDate: draftDayDate,
  })
  const draftLookupKey = buildFlightLookupKey(draftFlightLookup?.flightNumber, draftFlightLookup?.date)
  const manualOrderLookup = useMemo(() => {
    const lookup = {}
    const counts = {}

    filteredItems.forEach((item) => {
      if (item.generated) return
      if (!counts[item.dayId]) counts[item.dayId] = 0
      lookup[item.id] = counts[item.dayId]
      counts[item.dayId] += 1
    })

    return {
      positions: lookup,
      counts,
    }
  }, [filteredItems])
  const visibleManualCount =
    activeDayId === DAY_VIEW_ALL ? 0 : manualOrderLookup.counts[activeDayId] || 0
  const draftScheduleConflict = useMemo(() => {
    if (!effectiveDraftDayId) return null
    const existingItems = dayMap[effectiveDraftDayId]?.items || []
    return getScheduleConflictMeta([
      ...existingItems,
      { ...draft, id: draftConflictId, dayId: effectiveDraftDayId },
    ])
  }, [dayMap, draft, effectiveDraftDayId])

  useEffect(() => {
    if (draft.category !== 'Flight' || !draftFlightLookup?.flightNumber || !draftFlightLookup.date) return undefined
    if (!isCurrentDate(draftDayDate) && draftAppliedLookupKey === draftLookupKey) {
      return undefined
    }

    let active = true

    async function syncDraftFlight() {
      try {
        const record = await getFlightRecord({
          date: draftFlightLookup.date,
          flightCode: draftFlightLookup.flightNumber,
          forceRefresh: isCurrentDate(draftFlightLookup.date),
        })

        if (!active || !record) return

        setDraft((current) => {
          const currentFlightCode = current.flightCode || extractFlightNumber(current.title || '')
          const currentDayDate = dayMap[
            current.dayId && dayOptions.some((day) => day.id === current.dayId)
              ? current.dayId
              : effectiveDraftDayId
          ]?.date || ''
          const currentLookupKey = buildFlightLookupKey(currentFlightCode, currentDayDate)

          if (
            current.category !== 'Flight' ||
            currentFlightCode !== draftFlightLookup.flightNumber ||
            currentLookupKey !== draftLookupKey
          ) {
            return current
          }

          if (!isCurrentDate(draftFlightLookup.date) && hasAppliedFlightLookup(current, draftLookupKey)) {
            return current
          }

          return applyFlightRecordToDraft(current, record, draftFlightLookup.flightNumber, draftLookupKey)
        })
      } catch (error) {
        console.error(error)
      }
    }

    void syncDraftFlight()
    return () => {
      active = false
    }
  }, [
    dayMap,
    dayOptions,
    draft.category,
    draftAppliedLookupKey,
    draft.dayId,
    draft.title,
    draftDayDate,
    draftFlightLookup,
    draftLookupKey,
    effectiveDraftDayId,
    getFlightRecord,
  ])

  async function saveNewItem() {
    if (!firestoreReady || !effectiveDraftDayId) return

    let nextDraft = normalizeItemTimeFields({
      ...draft,
      dayId: effectiveDraftDayId,
    })

    if (nextDraft.category === 'Flight' && draftFlightLookup?.flightNumber && draftFlightLookup.date) {
      try {
        const record = await getFlightRecord({
          date: draftFlightLookup.date,
          flightCode: draftFlightLookup.flightNumber,
          forceRefresh: isCurrentDate(draftFlightLookup.date),
        })

        if (record) {
          nextDraft = applyFlightRecordToDraft(
            nextDraft,
            record,
            draftFlightLookup.flightNumber,
            draftLookupKey,
          )
        }
      } catch (error) {
        console.error(error)
      }
    }

    await onSaveNewItem({
      ...normalizeItemTimeFields(nextDraft),
      dayId: effectiveDraftDayId,
      id: slugId('item'),
    })

    setDraft(buildEmptyDraft(activeDayId !== DAY_VIEW_ALL ? activeDayId : dayOptions[0]?.id || ''))
    setIsComposerOpen(false)
  }

  return (
    <>
      <div className="sticky top-4 z-20 space-y-2.5 browse-ui">
        <div className="glass-panel rounded-[1.25rem] border border-white/60 px-3.5 py-3 sm:rounded-[1.45rem] sm:px-5 sm:py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              {activeDayId !== DAY_VIEW_ALL ? (
                <h2 className={`headline leading-none tracking-[-0.025em] text-slate-900 ${isMobilePortrait ? 'text-[1.44rem]' : 'text-[1.84rem]'}`}>
                  {dayOptions.find((day) => day.id === activeDayId)?.label || 'Day view'}
                </h2>
              ) : null}
              <div
                className={`${activeDayId === DAY_VIEW_ALL ? '' : 'mt-1 '}text-slate-500 ${isMobilePortrait ? 'text-[12px]' : 'text-[13px]'}`}
              >
                {activeDayId === DAY_VIEW_ALL
                  ? `${filteredItems.length} stops across ${dayOptions.length} days`
                  : dayOptions.find((day) => day.id === activeDayId)?.name ||
                    formatFullDayDate(dayOptions.find((day) => day.id === activeDayId)?.date || '')}
              </div>
            </div>
            <button
              type="button"
              onClick={onManageDays}
              className={`shrink-0 rounded-full border border-slate-200/90 bg-white text-slate-700 transition hover:border-slate-300 hover:bg-slate-50 ${
                isMobilePortrait ? 'p-2.5' : 'flex items-center gap-2 px-3.5 py-2'
              }`}
              aria-label="Manage days"
            >
              <CalendarDays className={`${isMobilePortrait ? 'h-4 w-4' : 'h-4 w-4'}`} />
              {!isMobilePortrait ? <span className="text-sm font-semibold">Manage days</span> : null}
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <div className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
              Days
            </div>
            <div className="min-w-0 flex-1">
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-0.5">
                <button
                  type="button"
                  onClick={() => onDayChange(DAY_VIEW_ALL)}
                  className={`shrink-0 rounded-full px-3 py-2 text-left transition ${
                    activeDayId === DAY_VIEW_ALL ? 'bg-slate-900 text-white shadow-[0_6px_18px_rgba(15,23,42,0.12)]' : 'bg-white text-slate-600'
                  }`}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em]">Overview</div>
                </button>
                {dayOptions.map((day, index) => (
                  <button
                    key={day.id}
                    type="button"
                    data-day-drop-id={day.id}
                    onClick={() => onDayChange(day.id)}
                    className={`shrink-0 rounded-full px-3 py-2 text-left transition ${
                      dragState?.overDayId === day.id
                        ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200'
                        : activeDayId === day.id
                          ? 'bg-slate-900 text-white shadow-[0_6px_18px_rgba(15,23,42,0.12)]'
                          : 'bg-white text-slate-600'
                    }`}
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.05em]">
                      Day {index + 1}
                      <span className={`ml-1.5 font-medium normal-case tracking-normal ${activeDayId === day.id ? 'text-white/72' : 'text-slate-400'}`}>
                        {formatDayDate(day.date)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 text-[11px] leading-5 text-slate-500">
            Timeline auto-sorts by start time. Drag only affects items with the same start time.
          </div>

          {weatherDisplay ? (
            isMobilePortrait ? (
              <div className="mt-3 flex items-center gap-3 rounded-[0.9rem] bg-white px-3 py-2.5">
                <div className="rounded-xl bg-slate-100 p-2 text-slate-700">
                  <weatherDisplay.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-slate-900">
                    {weatherDisplay.compact || weatherDisplay.headline}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-slate-500">{weatherDisplay.detail}</div>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex items-center justify-between gap-4 rounded-[1rem] bg-white px-4 py-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">Weather</p>
                  <div className="mt-1 text-[15px] font-semibold text-slate-900">{weatherDisplay.headline}</div>
                  <div className="mt-1 text-[13px] text-slate-500">{weatherDisplay.detail}</div>
                </div>
                <div className="rounded-[1rem] bg-slate-100 p-3 text-slate-700">
                  <weatherDisplay.icon className="h-5 w-5" />
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div className="space-y-2.5 browse-ui">
        {filteredItems.map((item, index) => {
          const meta = typeMeta(item.category)
          const nextSegment = routeSegments[index]
          const isOverview = activeDayId === DAY_VIEW_ALL
          const previousItem = filteredItems[index - 1]
          const nextItem = filteredItems[index + 1]
          const showDayDivider = isOverview && (!previousItem || previousItem.dayId !== item.dayId)
          const dayContext = dayOptions.find((day) => day.id === item.dayId)
          const manualIndex = manualOrderLookup.positions[item.id]
          const isManual = !item.generated
          const showBeforeSlot = Boolean(dragState && isManual)
          const showAfterSlot =
            Boolean(dragState && isManual) &&
            (!nextItem || nextItem.dayId !== item.dayId || nextItem.generated)
          const isDraggingItem = dragState?.itemId === item.id
          return (
            <div key={item.id} className="space-y-2">
              {showDayDivider ? (
                <div className="flex items-center gap-3 px-1 py-4 first:pt-0">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                      {dayContext?.label || 'Day'}
                    </div>
                    <div className="mt-1 text-[13px] text-slate-500">
                      {dayContext?.name || formatFullDayDate(dayContext?.date || '')}
                    </div>
                  </div>
                  <div className="quiet-divider h-px flex-1" />
                </div>
              ) : null}
              {showBeforeSlot ? (
                <button
                  type="button"
                  data-drop-slot-day-id={item.dayId}
                  data-drop-slot-index={manualIndex}
                  className={`block h-4 w-full rounded-full border border-dashed transition ${
                    dragState?.slot?.dayId === item.dayId && dragState?.slot?.index === manualIndex
                      ? 'border-indigo-400 bg-indigo-100/70'
                      : 'border-slate-300/80 bg-transparent'
                  }`}
                  aria-label={`Move before ${item.title}`}
                />
              ) : null}
              <article
                className={`timeline-card relative rounded-[1.25rem] px-4 py-4 transition hover:bg-white/90 active:bg-white/95 sm:px-5 ${
                  isDraggingItem ? 'scale-[0.995] opacity-45 ring-2 ring-slate-300/70' : ''
                }`}
                onClick={() => onOpenNotes(item)}
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => onOpenDetails.startPress(event, item)}
                onPointerMove={onOpenDetails.movePress}
                onPointerUp={(event) => onOpenDetails.endPress(event, item)}
                onPointerCancel={onOpenDetails.cancelPress}
                onPointerLeave={onOpenDetails.cancelPress}
              >
                <div className="flex gap-4 sm:gap-5">
                  <div className="w-[3.55rem] shrink-0 pt-0.5 text-right">
                    <div className="text-[13px] font-semibold tracking-[-0.01em] text-slate-900">{item.startTime}</div>
                    {item.endTime ? <div className="mt-1 text-[10px] font-medium tracking-[-0.01em] text-slate-400">{item.endTime}</div> : null}
                  </div>
                  <div className="timeline-rail shrink-0">
                    <span className={`timeline-dot ${meta.tone}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-[0.98rem] font-semibold leading-6 tracking-[-0.015em] text-slate-900">{item.title}</h3>
                        <p className="mt-1 truncate text-[12px] text-slate-500">{item.locationName || item.address}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.generated ? (
                          <div className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-700">
                            Linked
                          </div>
                        ) : (
                          <button
                            type="button"
                            onPointerDown={(event) => onDragStart(event, item)}
                            onClick={(event) => event.stopPropagation()}
                            data-drag-handle="true"
                            className="touch-none rounded-full bg-slate-100 p-2 text-slate-400 transition hover:bg-slate-200 hover:text-slate-700 active:scale-95"
                            aria-label={`Drag ${item.title}`}
                          >
                            <GripVertical className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    {item.address && item.address !== item.locationName ? (
                      <p className="mt-1 truncate text-[11px] text-slate-400">{item.address}</p>
                    ) : null}
                    {(item.description || item.generated) ? (
                      <p className="mt-2 line-clamp-2 text-[12px] leading-6 text-slate-500">
                        {item.generated ? 'Auto-carried from the previous day hotel stay.' : item.description}
                      </p>
                    ) : null}
                  </div>
                </div>
              </article>

              {nextSegment ? (
                <div
                  className={`ml-[4.85rem] rounded-[0.9rem] px-4 py-1.5 text-[11px] text-slate-500 sm:ml-[5.9rem] ${
                    isMobilePortrait
                      ? 'flex items-center justify-between gap-3'
                      : 'flex items-center justify-between gap-4'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="font-medium text-slate-700">{routeLabel(nextSegment.mode)}</span>
                    <span>
                      {nextSegment.route
                        ? `${nextSegment.route.estimated ? '~' : ''}${Math.round(nextSegment.route.durationMin)} min`
                        : 'Loading route'}
                    </span>
                    {nextSegment.route ? (
                      <span className="truncate">
                        {nextSegment.route.estimated ? '~' : ''}
                        {nextSegment.route.distanceKm.toFixed(1)} km
                      </span>
                    ) : null}
                  </div>
                  <RouteModeControl
                    currentMode={nextSegment.from.travelModeToNext || ''}
                    onSelect={(mode) => onUpdateTravelMode(nextSegment.from.id, mode)}
                  />
                </div>
              ) : null}
              {showAfterSlot ? (
                <button
                  type="button"
                  data-drop-slot-day-id={item.dayId}
                  data-drop-slot-index={(manualOrderLookup.counts[item.dayId] || 0)}
                  className={`block h-4 w-full rounded-full border border-dashed transition ${
                    dragState?.slot?.dayId === item.dayId &&
                    dragState?.slot?.index === (manualOrderLookup.counts[item.dayId] || 0)
                      ? 'border-indigo-400 bg-indigo-100/70'
                      : 'border-slate-300/80 bg-transparent'
                  }`}
                  aria-label={`Move after ${item.title}`}
                />
              ) : null}
            </div>
          )
        })}
        {dragState && activeDayId !== DAY_VIEW_ALL && visibleManualCount === 0 ? (
          <button
            type="button"
            data-drop-slot-day-id={activeDayId}
            data-drop-slot-index={0}
            className={`flex h-14 w-full items-center justify-center rounded-[1.15rem] border border-dashed text-sm font-medium transition ${
              dragState?.slot?.dayId === activeDayId && dragState?.slot?.index === 0
                ? 'border-indigo-400 bg-indigo-100/70 text-indigo-700'
                : 'border-slate-300/80 text-slate-500'
            }`}
          >
            Drop stop into this day
          </button>
        ) : null}
      </div>

      <div className="glass-panel rounded-[1.35rem] border border-white/60 px-4 py-4 sm:px-5 browse-ui">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="headline text-[1.66rem] leading-none tracking-[-0.025em] text-slate-900">Add stop</h3>
            <p className="mt-1 text-[13px] text-slate-500">Open the composer only when you need it.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsComposerOpen((open) => !open)}
            className={`rounded-[0.95rem] px-4 py-2.5 text-[13px] font-semibold transition ${
              isComposerOpen ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'
            }`}
          >
            {isComposerOpen ? 'Hide form' : 'New stop'}
          </button>
        </div>

        {isComposerOpen ? (
          <>
            <div className={`mt-5 grid gap-3.5 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
              <Field label="Day">
                <select
                  value={effectiveDraftDayId}
                  onChange={(event) => setDraft((current) => ({ ...current, dayId: event.target.value }))}
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                >
                  {dayOptions.map((day) => (
                    <option key={day.id} value={day.id}>
                      {day.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <select
                  value={draft.category}
                  onChange={(event) =>
                    setDraft((current) => {
                      const nextCategory = event.target.value
                      if (nextCategory === 'Flight') {
                        return {
                          ...current,
                          category: nextCategory,
                          startTime: '',
                          endTime: '',
                          endTimeMode: 'time',
                          durationMinutes: null,
                        }
                      }

                      return {
                        ...current,
                        category: nextCategory,
                        startTime: current.startTime || '10:00',
                        endTime: current.endTime || '11:00',
                        endTimeMode: current.endTimeMode || 'time',
                      }
                    })
                  }
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                >
                  {CATEGORY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={draft.category === 'Flight' ? 'Flight code' : 'Title'}>
                <input
                  value={draft.category === 'Flight' ? draftFlightCode : draft.title}
                  onChange={(event) =>
                    setDraft((current) =>
                      draft.category === 'Flight'
                        ? { ...current, flightCode: event.target.value.toUpperCase().replace(/\s+/g, '') }
                        : { ...current, title: event.target.value },
                    )
                  }
                  placeholder={draft.category === 'Flight' ? 'CX549' : ''}
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <TimeField
                label="Start time"
                value={draft.startTime}
                onChange={(event) =>
                  setDraft((current) => applyItemDraftPatch(current, { startTime: event.target.value }))
                }
                disabled={draft.category === 'Flight'}
                conflict={Boolean(draftScheduleConflict?.nextId === draftConflictId)}
              />
              {draft.category === 'Flight' ? (
                <TimeField
                  label="End time"
                  value={draft.endTime}
                  onChange={() => {}}
                  disabled
                  conflict={Boolean(draftScheduleConflict?.currentId === draftConflictId)}
                />
              ) : (
                <EndTimeModeField
                  disabled={false}
                  draft={draft}
                  onChange={(changes) => setDraft((current) => applyItemDraftPatch(current, changes))}
                  conflict={Boolean(draftScheduleConflict?.currentId === draftConflictId)}
                />
              )}
            </div>

            {getEndTimeWarning(draft) ? (
              <div className="mt-3 rounded-[0.95rem] bg-amber-50/90 px-4 py-3 text-[13px] leading-6 text-amber-700">
                {getEndTimeWarning(draft)}
              </div>
            ) : null}

            <div className="mt-4 space-y-3">
              {draft.category !== 'Flight' ? (
                <PlaceFields
                  draft={draft}
                  disabled={!firestoreReady}
                  mapsReady={mapsReady}
                  onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
                />
              ) : null}

              <Field label="Notes">
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Booking ref">
                <input
                  value={draft.bookingRef}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, bookingRef: event.target.value }))
                  }
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                />
              </Field>
            </div>

            <button
              type="button"
              onClick={() => void saveNewItem()}
              disabled={!firestoreReady || !effectiveDraftDayId}
              className="mt-5 w-full rounded-[1.1rem] bg-slate-900 px-4 py-4 text-sm font-bold text-white disabled:bg-slate-300"
            >
              Save new itinerary detail
            </button>
          </>
        ) : (
          <div className="mt-4 rounded-[0.95rem] bg-white px-4 py-3 text-[13px] leading-6 text-slate-500">
            Open the composer only when you need to add a new stop.
          </div>
        )}
      </div>
    </>
  )
}

function MapPanel({ activeDayId, filteredItems, isMobilePortrait, mapsReady, mapsError, routeSegments }) {
  const mapItems = useMemo(() => buildMapItems(filteredItems), [filteredItems])

  return (
    <div className="browse-ui">
      <div className="glass-panel rounded-[1.35rem] border border-white/60 px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="headline text-[1.66rem] leading-none tracking-[-0.025em] text-slate-900">Map</h2>
            <p className="mt-1 text-[13px] text-slate-500">
              {activeDayId === DAY_VIEW_ALL ? 'Whole trip view' : 'Selected day route'}
            </p>
          </div>
        </div>

        <div
          className={`mt-4 overflow-hidden rounded-[1.35rem] border border-slate-200/80 bg-slate-100 ${
            isMobilePortrait ? 'h-[260px]' : 'h-[320px]'
          }`}
        >
          {mapsReady ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center bg-slate-100 text-sm font-medium text-slate-500">
                  Loading map...
                </div>
              }
            >
              <TripMap filteredItems={mapItems} routeSegments={routeSegments} />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center bg-slate-100 px-6 text-center text-sm font-medium text-slate-500">
              {mapsError || 'Add VITE_GOOGLE_MAPS_API_KEY to enable Google Maps.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const MemoMapPanel = memo(MapPanel)

export default function App() {
  const googleMapsState = useGoogleMapsApi(MAPS_API_KEY)
  const [activeDayId, setActiveDayId] = useState(DAY_VIEW_ALL)
  const [activeTripId, setActiveTripId] = useState(() => {
    if (typeof window === 'undefined') return TRIP_ID
    return window.localStorage.getItem(ACTIVE_TRIP_STORAGE_KEY) || TRIP_ID
  })
  const [overrides, setOverrides] = useState({ days: {}, items: {} })
  const [tripSummaries, setTripSummaries] = useState([])
  const [authReady, setAuthReady] = useState(false)
  const [firestoreState, setFirestoreState] = useState({
    status: firebaseEnabled ? 'connecting' : 'disabled',
    error: '',
  })
  const [weatherState, setWeatherState] = useState({
    loading: true,
    data: null,
    error: '',
    targetKey: '',
  })
  const [noteItem, setNoteItem] = useState(null)
  const [detailItem, setDetailItem] = useState(null)
  const [routeMap, setRouteMap] = useState({})
  const [showDayManager, setShowDayManager] = useState(false)
  const [dragState, setDragState] = useState(null)

  const isMobilePortrait = useResponsiveMode()
  const routeCacheRef = useRef(new Map())
  const flightLookupCacheRef = useRef(new Map())
  const dragDaySwitchRef = useRef(null)
  const dragAutoScrollFrameRef = useRef(null)
  const dragPointerRef = useRef({ x: 0, y: 0 })
  const dragStateRef = useRef(null)
  const pressStateRef = useRef({
    timer: null,
    pointerId: null,
    itemId: null,
    startX: 0,
    startY: 0,
    moved: false,
    longPressed: false,
  })
  const defaultTripSummary = useMemo(() => buildDefaultTripSummary(), [])
  const deletedTrips = useMemo(
    () =>
      tripSummaries
        .filter((trip) => trip.hidden)
        .sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [tripSummaries],
  )
  const availableTrips = useMemo(() => {
    const tripMap = new Map(tripSummaries.filter((trip) => !trip.hidden).map((trip) => [trip.id, trip]))
    if (!tripMap.has(defaultTripSummary.id)) {
      tripMap.set(defaultTripSummary.id, defaultTripSummary)
    }

    return [...tripMap.values()].sort((a, b) => {
      if (a.id === defaultTripSummary.id) return -1
      if (b.id === defaultTripSummary.id) return 1
      return (a.title || '').localeCompare(b.title || '')
    })
  }, [defaultTripSummary, tripSummaries])
  const resolvedTripId = availableTrips.some((trip) => trip.id === activeTripId)
    ? activeTripId
    : defaultTripSummary.id

  const tripState = useMemo(() => deriveTripState(overrides), [overrides])
  const activeTripSummary =
    availableTrips.find((trip) => trip.id === resolvedTripId) || defaultTripSummary
  const visibleDays = tripState.days
  const resolvedActiveDayId =
    activeDayId === DAY_VIEW_ALL || tripState.dayMap[activeDayId]
      ? activeDayId
      : visibleDays[0]?.id || DAY_VIEW_ALL
  const dayOptions = useMemo(
    () =>
      visibleDays.map((day) => ({
        id: day.id,
        date: day.date,
        name: day.name || '',
        label: day.label,
      })),
    [visibleDays],
  )
  const filteredItems = useMemo(
    () => movementItemsForDay(resolvedActiveDayId, tripState),
    [resolvedActiveDayId, tripState],
  )
  const deferredItems = useDeferredValue(filteredItems)
  const selectedWeather =
    resolvedActiveDayId === DAY_VIEW_ALL
      ? null
      : weatherState.data?.dailyByDate?.[tripState.dayMap[resolvedActiveDayId]?.date || ''] ?? null
  const weatherTarget = useMemo(() => {
    const sourceItems =
      resolvedActiveDayId === DAY_VIEW_ALL
        ? tripState.items
        : tripState.dayMap[resolvedActiveDayId]?.items || []
    return getWeatherTarget(sourceItems)
  }, [resolvedActiveDayId, tripState.dayMap, tripState.items])
  const weatherTargetKey = weatherTarget
    ? `${weatherTarget.lat.toFixed(4)},${weatherTarget.lng.toFixed(4)}`
    : ''
  const effectiveWeatherState = weatherTarget
    ? {
        ...weatherState,
        loading: weatherState.targetKey !== weatherTargetKey,
      }
    : { loading: false, data: null, error: '' }
  const firestoreReady = firebaseEnabled && authReady && firestoreState.status === 'ready'
  const detailItemId = detailItem?.id || ''
  const detailCategory = detailItem?.category || ''
  const detailAppliedLookupKey = detailItem?.flightInfo?.lookupKey || ''
  const detailDayDate = detailItem?.dayId ? tripState.dayMap[detailItem.dayId]?.date || '' : ''
  const detailFlightLookup = inferFlightLookupFromItem({
    ...(detailItem || {}),
    flightCode: detailItem?.flightCode || extractFlightNumber(detailItem?.title || ''),
    dayDate: detailDayDate,
  })
  const detailFlightCode = detailFlightLookup?.flightNumber || ''
  const detailFlightLookupKey = buildFlightLookupKey(detailFlightLookup?.flightNumber, detailFlightLookup?.date)
  const detailScheduleConflict = useMemo(() => {
    if (!detailItem?.dayId) return null
    const existingItems = (tripState.dayMap[detailItem.dayId]?.items || []).filter(
      (item) => item.id !== detailItem.id,
    )
    return getScheduleConflictMeta([...existingItems, detailItem])
  }, [detailItem, tripState.dayMap])
  const detailEndTimeWarning = useMemo(() => getEndTimeWarning(detailItem), [detailItem])

  const getFlightRecord = useMemo(
    () =>
      async ({ date, flightCode, forceRefresh = false }) => {
        const normalizedCode = extractFlightNumber(flightCode)
        const lookupKey = buildFlightLookupKey(normalizedCode, date)

        if (!normalizedCode || !date || !lookupKey) return null

        if (!forceRefresh) {
          const cached = flightLookupCacheRef.current.get(lookupKey)
          if (cached) return cached
        }

        const payload = await fetchFlightStatusByNumber({
          date,
          flightNumber: normalizedCode,
          withLocation: true,
        })
        const record = selectFlightRecord(payload.records || [], normalizedCode)

        if (record) {
          flightLookupCacheRef.current.set(lookupKey, record)
        }

        return record
      },
    [],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(ACTIVE_TRIP_STORAGE_KEY, resolvedTripId)
  }, [resolvedTripId])

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    return () => {
      if (dragDaySwitchRef.current) {
        window.clearTimeout(dragDaySwitchRef.current)
      }
    }
  }, [])

  useEffect(() => {
    let active = true

    async function bootstrap() {
      if (!firebaseEnabled) {
        if (active) {
          setAuthReady(true)
          setTripSummaries([defaultTripSummary])
          setFirestoreState({ status: 'disabled', error: 'Firebase env vars missing' })
        }
        return
      }

      try {
        await ensureAnonymousAuth()
        if (!active) return

        setAuthReady(true)
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
    }
  }, [defaultTripSummary])

  useEffect(() => {
    if (!authReady || !firebaseEnabled) return undefined

    let active = true
    let unsubscribe = () => {}

    async function connectDirectory() {
      unsubscribe = await subscribeToTripDirectory(
        (payload) => {
          if (!active) return
          setTripSummaries(payload || [])
        },
        (error) => {
          console.error(error)
          if (active) {
            setFirestoreState({ status: 'error', error: error?.message || 'Trip list failed' })
          }
        },
      )
    }

    void connectDirectory()
    return () => {
      active = false
      unsubscribe()
    }
  }, [authReady])

  useEffect(() => {
    if (!authReady || !firebaseEnabled || !resolvedTripId) return undefined

    let active = true
    let unsubscribe = () => {}

    async function connectTrip() {
      unsubscribe = await subscribeToTripState(
        resolvedTripId,
        (payload) => {
          if (!active) return
          setOverrides({
            days: payload?.days || {},
            items: payload?.items || {},
          })
          setFirestoreState({ status: 'ready', error: '' })
        },
        (error) => {
          console.error(error)
          if (active) {
            setFirestoreState({ status: 'error', error: error?.message || 'Snapshot failed' })
          }
        },
      )
    }

    void connectTrip()
    return () => {
      active = false
      unsubscribe()
    }
  }, [authReady, resolvedTripId])

  useEffect(() => {
    let cancelled = false

    if (!weatherTarget) return undefined

    fetchWeatherSnapshot(weatherTarget)
      .then((data) => {
        if (!cancelled) setWeatherState({ loading: false, data, error: '', targetKey: weatherTargetKey })
      })
      .catch((error) => {
        console.error(error)
        if (!cancelled) {
          setWeatherState({
            loading: false,
            data: null,
            error: 'Weather unavailable',
            targetKey: weatherTargetKey,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [weatherTarget, weatherTargetKey])

  useEffect(() => {
    if (!firestoreReady) return
    if (tripSummaries.some((trip) => trip.id === defaultTripSummary.id)) return

    void upsertTripMeta(defaultTripSummary.id, {
      title: defaultTripSummary.title,
      startDate: defaultTripSummary.startDate,
      endDate: defaultTripSummary.endDate,
    })
  }, [defaultTripSummary, firestoreReady, tripSummaries])

  useEffect(() => {
    if (!detailItemId || detailCategory !== 'Flight' || !detailFlightCode || !detailDayDate) {
      return undefined
    }
    if (!isCurrentDate(detailDayDate) && detailAppliedLookupKey === detailFlightLookupKey) {
      return undefined
    }

    let active = true

    async function syncDetailFlight() {
      try {
        const record = await getFlightRecord({
          date: detailDayDate,
          flightCode: detailFlightCode,
          forceRefresh: isCurrentDate(detailDayDate),
        })

        if (!active || !record) return

        setDetailItem((current) => {
          if (!current) return current

          const currentFlightCode = current.flightCode || extractFlightNumber(current.title || '')
          const currentDayDate = current.dayId ? tripState.dayMap[current.dayId]?.date || '' : ''
          const currentLookupKey = buildFlightLookupKey(currentFlightCode, currentDayDate)

          if (
            current.id !== detailItemId ||
            current.category !== 'Flight' ||
            currentFlightCode !== detailFlightCode ||
            currentLookupKey !== detailFlightLookupKey
          ) {
            return current
          }

          if (!isCurrentDate(detailDayDate) && hasAppliedFlightLookup(current, detailFlightLookupKey)) {
            return current
          }

          return applyFlightRecordToDraft(current, record, detailFlightCode, detailFlightLookupKey)
        })
      } catch (error) {
        console.error(error)
      }
    }

    void syncDetailFlight()
    return () => {
      active = false
    }
  }, [
    detailDayDate,
    detailFlightCode,
    detailFlightLookupKey,
    detailAppliedLookupKey,
    detailCategory,
    detailItemId,
    getFlightRecord,
    tripState.dayMap,
  ])

  const routePairs = useMemo(() => makeMovementPairs(deferredItems), [deferredItems])

  function selectTrip(tripId) {
    setOverrides({ days: {}, items: {} })
    setNoteItem(null)
    setDetailItem(null)
    setDragState(null)
    setRouteMap({})
    setActiveDayId(DAY_VIEW_ALL)
    setActiveTripId(tripId)
  }

  function clearDragState() {
    if (dragDaySwitchRef.current) {
      window.clearTimeout(dragDaySwitchRef.current)
      dragDaySwitchRef.current = null
    }
    if (dragAutoScrollFrameRef.current) {
      window.cancelAnimationFrame(dragAutoScrollFrameRef.current)
      dragAutoScrollFrameRef.current = null
    }
    dragStateRef.current = null
    setDragState(null)
  }

  function beginItemDrag(event, item) {
    if (!firestoreReady || item.generated) return
    if (event.currentTarget?.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    event.preventDefault()
    event.stopPropagation()
    clearPressState()
    setDragState({
      itemId: item.id,
      overDayId: item.dayId,
      slot: null,
    })
  }

  useEffect(() => {
    if (!dragState?.itemId) return undefined
    const previousTouchAction = document.body.style.touchAction
    document.body.style.touchAction = 'none'

    function preventTouchMove(event) {
      event.preventDefault()
    }

    function updateDragTarget(clientX, clientY) {
      const currentDrag = dragStateRef.current
      if (!currentDrag) return
      const target = document.elementFromPoint(clientX, clientY)
      if (!target) {
        setDragState((current) => (current ? { ...current, overDayId: null, slot: null } : current))
        return
      }

      const slotNode = target.closest('[data-drop-slot-day-id]')
      if (slotNode) {
        const dayId = slotNode.getAttribute('data-drop-slot-day-id')
        const index = Number(slotNode.getAttribute('data-drop-slot-index'))
        setDragState((current) =>
          current
            ? {
                ...current,
                overDayId: dayId,
                slot: Number.isFinite(index) ? { dayId, index } : null,
              }
            : current,
        )
        return
      }

      const dayNode = target.closest('[data-day-drop-id]')
      if (dayNode) {
        const dayId = dayNode.getAttribute('data-day-drop-id')
        setDragState((current) => (current ? { ...current, overDayId: dayId, slot: null } : current))

        if (dayId && dayId !== resolvedActiveDayId) {
          if (dragDaySwitchRef.current) {
            window.clearTimeout(dragDaySwitchRef.current)
          }
          dragDaySwitchRef.current = window.setTimeout(() => {
            startTransition(() => {
              setActiveDayId(dayId)
            })
          }, DROP_DAY_SWITCH_MS)
        }
        return
      }

      if (dragDaySwitchRef.current) {
        window.clearTimeout(dragDaySwitchRef.current)
        dragDaySwitchRef.current = null
      }
      setDragState((current) => (current ? { ...current, overDayId: null, slot: null } : current))
    }

    function tickAutoScroll() {
      if (!dragStateRef.current) {
        dragAutoScrollFrameRef.current = null
        return
      }

      const edgeThreshold = 88
      const maxStep = 18
      const { x, y } = dragPointerRef.current
      let deltaY = 0

      if (y < edgeThreshold) {
        deltaY = -Math.ceil(((edgeThreshold - y) / edgeThreshold) * maxStep)
      } else if (y > window.innerHeight - edgeThreshold) {
        deltaY = Math.ceil(((y - (window.innerHeight - edgeThreshold)) / edgeThreshold) * maxStep)
      }

      if (deltaY !== 0) {
        const scroller = document.scrollingElement || document.documentElement
        const previousTop = scroller.scrollTop
        window.scrollBy(0, deltaY)
        if (scroller.scrollTop !== previousTop) {
          updateDragTarget(x, y)
        }
      }

      dragAutoScrollFrameRef.current = window.requestAnimationFrame(tickAutoScroll)
    }

    function handlePointerMove(event) {
      if (!dragStateRef.current) return
      dragPointerRef.current = { x: event.clientX, y: event.clientY }
      updateDragTarget(event.clientX, event.clientY)
    }

    async function handlePointerUp() {
      const currentDrag = dragStateRef.current
      const dropSlot = currentDrag?.slot
      clearDragState()
      if (!dropSlot) return

      const patchItems = reorderTripItems(tripState, currentDrag.itemId, dropSlot.dayId, dropSlot.index)
      if (!patchItems.length) return

      await mergeTripPatch(
        resolvedTripId,
        {
          items: Object.fromEntries(patchItems.map((item) => [item.id, item])),
        },
      )
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', clearDragState)
    window.addEventListener('touchmove', preventTouchMove, { passive: false })
    dragAutoScrollFrameRef.current = window.requestAnimationFrame(tickAutoScroll)

    return () => {
      document.body.style.touchAction = previousTouchAction
      if (dragAutoScrollFrameRef.current) {
        window.cancelAnimationFrame(dragAutoScrollFrameRef.current)
        dragAutoScrollFrameRef.current = null
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', clearDragState)
      window.removeEventListener('touchmove', preventTouchMove)
    }
  }, [dragState?.itemId, resolvedActiveDayId, resolvedTripId, tripState])

  useEffect(() => {
    let cancelled = false
    if (!googleMapsState.ready || !window.google?.maps || !routePairs.length) return undefined

    async function loadRoutes() {
      const entries = await Promise.all(
        routePairs.map(async ([fromPoint, toPoint, fromItem, toItem]) => {
          const mode = getRouteMode(fromItem, toItem)
          const key = `${fromItem.id}:${toItem.id}:${mode}:${fromPoint.lat},${fromPoint.lng}:${toPoint.lat},${toPoint.lng}`
          const cached = routeCacheRef.current.get(key)
          if (cached) return [key, cached]

          try {
            const result = await requestDirectionsRoute(fromPoint, toPoint, mode)

            const summary = toRouteSummary(result, mode)
            routeCacheRef.current.set(key, summary)
            return [key, summary]
          } catch (error) {
            console.error(error)
            try {
              const retried = await requestDirectionsRoute(fromPoint, toPoint, mode)
              const summary = toRouteSummary(retried, mode)
              routeCacheRef.current.set(key, summary)
              return [key, summary]
            } catch (retryError) {
              console.error(retryError)
              const fallback = buildFallbackRouteSummary(fromPoint, toPoint, mode)
              routeCacheRef.current.set(key, fallback)
              return [key, fallback]
            }
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
  }, [googleMapsState.ready, routePairs])

  const routeSegments = useMemo(
    () =>
      routePairs.map(([fromPoint, toPoint, fromItem, toItem]) => {
        const mode = getRouteMode(fromItem, toItem)
        const key = `${fromItem.id}:${toItem.id}:${mode}:${fromPoint.lat},${fromPoint.lng}:${toPoint.lat},${toPoint.lng}`
        return { id: key, from: fromItem, to: toItem, route: routeMap[key], mode }
      }),
    [routePairs, routeMap],
  )

  async function saveItem(item) {
    const normalizedItem = normalizeItemTimeFields(item)
    const sameDayItems = (tripState.dayMap[item.dayId]?.items || []).filter((existing) => existing.id !== item.id)
    const manualItems = sameDayItems.filter((existing) => !existing.generated)
    const patchItems = Object.fromEntries(
      mergeItemsForDay(manualItems, normalizedItem).map((entry) => [entry.id, entry]),
    )
    await mergeTripPatch(resolvedTripId, { items: patchItems })
  }

  async function createTrip() {
    if (!firestoreReady) return

    const nextIndex = availableTrips.length + 1
    const suggestedTitle = `Trip ${nextIndex}`
    const title = window.prompt('Trip name', suggestedTitle)?.trim()
    if (!title) return

    const tripId = slugId('trip')
    const snapshot = serializeTripState(tripState)
    const nextSummary = {
      id: tripId,
      title,
      startDate: tripState.days[0]?.date || '',
      endDate: tripState.days[tripState.days.length - 1]?.date || '',
    }

    await createTripRecord(tripId, {
      title: nextSummary.title,
      startDate: nextSummary.startDate,
      endDate: nextSummary.endDate,
      days: snapshot.days,
      items: snapshot.items,
    })

    setTripSummaries((current) =>
      current.some((trip) => trip.id === tripId) ? current : [...current, nextSummary],
    )
    selectTrip(tripId)
  }

  async function renameTrip() {
    if (!firestoreReady) return

    const currentTitle = activeTripSummary?.title || 'Untitled trip'
    const nextTitle = window.prompt('Rename trip', currentTitle)?.trim()
    if (!nextTitle || nextTitle === currentTitle) return

    await upsertTripMeta(resolvedTripId, {
      title: nextTitle,
      startDate: tripState.days[0]?.date || activeTripSummary.startDate || '',
      endDate: tripState.days[tripState.days.length - 1]?.date || activeTripSummary.endDate || '',
    })
  }

  async function deleteTrip() {
    if (!firestoreReady) return
    if (resolvedTripId === defaultTripSummary.id) {
      window.alert('The default trip cannot be deleted.')
      return
    }

    const tripTitle = activeTripSummary?.title || 'this trip'
    if (!window.confirm(`Delete ${tripTitle}? This trip will be removed from the selector.`)) return

    const fallbackTrip =
      availableTrips.find((trip) => trip.id !== resolvedTripId && !trip.hidden) || defaultTripSummary

    await upsertTripMeta(resolvedTripId, {
      hidden: true,
    })

    selectTrip(fallbackTrip.id)
  }

  async function restoreTrip(tripId) {
    if (!firestoreReady || !tripId) return
    await upsertTripMeta(tripId, { hidden: false })
    selectTrip(tripId)
  }

  async function updateDay(dayId, changes) {
    if (changes.date) {
      const duplicate = visibleDays.find((day) => day.id !== dayId && day.date === changes.date)
      if (duplicate) {
        window.alert('Each day needs a unique date.')
        return
      }
    }
    await mergeTripPatch(resolvedTripId, { days: { [dayId]: changes } })
  }

  async function addDay(draft) {
    if (!firestoreReady || !draft.date) return
    if (visibleDays.some((day) => day.date === draft.date)) {
      window.alert('That date already exists in the itinerary.')
      return
    }

    const id = slugId('day')
    await mergeTripPatch(resolvedTripId, {
      days: {
        [id]: {
          id,
          date: draft.date,
          name: draft.name,
          order: visibleDays.length,
        },
      },
    })
    setActiveDayId(id)
  }

  async function moveDay(dayId, direction) {
    const index = visibleDays.findIndex((day) => day.id === dayId)
    const targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= visibleDays.length) return

    const reordered = [...visibleDays]
    const [day] = reordered.splice(index, 1)
    reordered.splice(targetIndex, 0, day)
    await mergeTripPatch(resolvedTripId, {
      days: Object.fromEntries(
        renumberDays(reordered).map((entry) => [entry.id, { order: entry.order }]),
      ),
    })
  }

  async function deleteDay(dayId) {
    const day = tripState.dayMap[dayId]
    if (!day) return
    if (!window.confirm(`Delete ${day.label}? This will delete every item under that day.`)) return

    const remaining = visibleDays.filter((entry) => entry.id !== dayId)
    await mergeTripPatch(resolvedTripId, {
      days: {
        [dayId]: { hidden: true },
        ...Object.fromEntries(
          renumberDays(remaining).map((entry) => [entry.id, { order: entry.order }]),
        ),
      },
      items: Object.fromEntries(
        tripState.items
          .filter((item) => item.dayId === dayId && !item.generated)
          .map((item) => [item.id, { hidden: true }]),
      ),
    })
    setActiveDayId(remaining[0]?.id || DAY_VIEW_ALL)
  }

  async function deleteItem(itemId) {
    await mergeTripPatch(resolvedTripId, { items: { [itemId]: { hidden: true } } })
    setNoteItem((current) => (current?.id === itemId ? null : current))
    setDetailItem((current) => (current?.id === itemId ? null : current))
  }

  async function updateTravelMode(itemId, travelModeToNext) {
    const targetItem = tripState.items.find((item) => item.id === itemId)
    if (!targetItem) return

    if (targetItem.generated) {
      await mergeTripPatch(resolvedTripId, {
        items: {
          [targetItem.id]: {
            ...generatedItemPatch(targetItem),
            travelModeToNext,
          },
        },
      })
      return
    }

    await saveItem({
      ...targetItem,
      travelModeToNext,
    })
  }

  function openNotes(item) {
    setNoteItem(item)
  }

  function openDetails(item) {
    setDetailItem(createItemDraft(item))
  }

  function updateDetail(changes) {
    setDetailItem((current) => (current ? applyItemDraftPatch(current, changes) : current))
  }

  async function saveDetailItem() {
    if (!detailItem || !firestoreReady) return

    const nextItem = normalizeItemTimeFields(detailItem)

    if (nextItem.generated) {
      await mergeTripPatch(resolvedTripId, {
        items: {
          [nextItem.id]: generatedItemPatch(nextItem),
        },
      })
    } else {
      await saveItem(nextItem)
    }

    setDetailItem(null)
  }

  function clearPressState() {
    const state = pressStateRef.current
    if (state.timer) window.clearTimeout(state.timer)
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

  function startPress(event, item) {
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

  function movePress(event) {
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

  function endPress(event, item) {
    const state = pressStateRef.current
    if (state.pointerId !== event.pointerId) return
    const shouldOpenNotes = !state.moved && !state.longPressed && state.itemId === item.id
    clearPressState()
    if (shouldOpenNotes) openNotes(item)
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl overflow-x-clip px-3 py-4 pb-8 text-slate-900 sm:px-6 sm:py-5 sm:pb-10 lg:px-8">
      <div className={isMobilePortrait ? 'mx-auto mb-4 max-w-[28rem]' : 'mb-4 max-w-md'}>
        <TripSwitcher
          activeTripId={activeTripSummary.id}
          deletedTrips={deletedTrips}
          disabled={!firestoreReady}
          isMobilePortrait={isMobilePortrait}
          onCreateTrip={() => void createTrip()}
          onDeleteTrip={() => void deleteTrip()}
          onRenameTrip={() => void renameTrip()}
          onRestoreTrip={(tripId) => void restoreTrip(tripId)}
          onSelectTrip={selectTrip}
          tripSummaries={availableTrips}
        />
      </div>
      <section
        className={
          isMobilePortrait
            ? 'mx-auto max-w-[28rem] space-y-4'
            : 'grid gap-6 lg:grid-cols-[1.08fr_0.92fr]'
        }
      >
        <div className="space-y-4">
          <PlannerPanel
            activeDayId={resolvedActiveDayId}
            dayOptions={dayOptions}
            dayMap={tripState.dayMap}
            dragState={dragState}
            filteredItems={filteredItems}
            firestoreReady={firestoreReady}
            getFlightRecord={getFlightRecord}
            isMobilePortrait={isMobilePortrait}
            mapsReady={googleMapsState.ready}
            onDayChange={(dayId) => {
              startTransition(() => {
                setActiveDayId(dayId)
              })
            }}
            onDragStart={beginItemDrag}
            onManageDays={() => setShowDayManager(true)}
            onOpenDetails={{
              startPress,
              movePress,
              endPress,
              cancelPress: clearPressState,
            }}
            onOpenNotes={openNotes}
            onSaveNewItem={saveItem}
            onUpdateTravelMode={(itemId, mode) => void updateTravelMode(itemId, mode)}
            routeSegments={routeSegments}
            selectedWeather={selectedWeather}
            weatherState={effectiveWeatherState}
          />
        </div>

        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <MemoMapPanel
            activeDayId={resolvedActiveDayId}
            filteredItems={deferredItems}
            isMobilePortrait={isMobilePortrait}
            mapsReady={googleMapsState.ready}
            mapsError={googleMapsState.error}
            routeSegments={routeSegments}
          />
        </div>
      </section>

      {showDayManager ? (
        <DayManagerModal
          activeDayId={resolvedActiveDayId}
          days={visibleDays}
          firestoreReady={firestoreReady}
          isMobilePortrait={isMobilePortrait}
          onAddDay={addDay}
          onClose={() => setShowDayManager(false)}
          onDeleteDay={deleteDay}
          onMoveDay={moveDay}
          onUpdateDay={updateDay}
        />
      ) : null}

      {noteItem ? (
        <NoteModal
          item={noteItem}
          isMobilePortrait={isMobilePortrait}
          onClose={() => setNoteItem(null)}
          onDelete={async () => {
            const id = noteItem.id
            setNoteItem(null)
            await deleteItem(id)
          }}
          onOpenDetails={() => {
            const match = tripState.items.find((item) => item.id === noteItem.id) || noteItem
            setNoteItem(null)
            openDetails(match)
          }}
        />
      ) : null}

      {detailItem ? (
        <DetailModal
          dayOptions={dayOptions}
          detailItem={detailItem}
          endTimeWarning={detailEndTimeWarning}
          firestoreReady={firestoreReady}
          isGenerated={Boolean(detailItem.generated)}
          isMobilePortrait={isMobilePortrait}
          mapsReady={googleMapsState.ready}
          onChange={updateDetail}
          onClose={() => setDetailItem(null)}
          onSave={saveDetailItem}
          scheduleConflict={detailScheduleConflict}
          onDelete={async () => {
            const id = detailItem.id
            setDetailItem(null)
            await deleteItem(id)
          }}
        />
      ) : null}
    </main>
  )
}
