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
  Check,
  Cloud,
  CloudRain,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Sun,
  Trash2,
  X,
} from 'lucide-react'
import { CATEGORY_OPTIONS, MAPS_API_KEY } from './data/seedItinerary'
import {
  ensureAnonymousAuth,
  firebaseEnabled,
  mergeTripPatch,
  subscribeToTripState,
} from './services/firebase'
import { fetchWeatherSnapshot } from './services/weather'
import {
  DAY_VIEW_ALL,
  buildDayLabel,
  compareTime,
  deriveTripState,
  formatFullDayDate,
  movementItemsForDay,
  nextDayDate,
  renumberDays,
  slugId,
} from './utils/trip'

const SAVE_DEBOUNCE_MS = 1000
const LONG_PRESS_MS = 600
const MOVE_THRESHOLD = 10
const TripMap = lazy(() => import('./components/TripMap'))

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
  return mode === 'walking' ? 'Walk' : 'Drive'
}

function getWeatherDisplay(activeDayId, weatherState, selectedWeather) {
  if (activeDayId === DAY_VIEW_ALL) return null

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
        ? `Open-Meteo currently covers ${formatFullDayDate(firstAvailable)} to ${formatFullDayDate(lastAvailable)} only.`
        : 'Open-Meteo has not returned a usable forecast window yet.',
    icon: Cloud,
  }
}

function buildEmptyDraft(dayId = '') {
  return {
    id: '',
    dayId,
    category: 'Activity',
    title: '',
    locationName: '',
    address: '',
    startTime: '10:00',
    endTime: '11:00',
    description: '',
    bookingRef: '',
    lat: null,
    lng: null,
    placeId: '',
  }
}

function generatedItemPatch(item) {
  return {
    id: item.id,
    dayId: item.dayId,
    startTime: item.startTime,
    endTime: item.endTime,
    description: item.description,
    bookingRef: item.bookingRef,
  }
}

function assignItemOrder(items) {
  return [...items]
    .sort((a, b) => {
      const timeCompare = compareTime(a.startTime, b.startTime)
      if (timeCompare !== 0) return timeCompare
      return (a.order ?? 0) - (b.order ?? 0)
    })
    .map((item, index) => ({
      ...item,
      order: index,
    }))
}

function mergeItemsForDay(currentItems, nextItem) {
  return assignItemOrder([...currentItems.filter((item) => item.id !== nextItem.id), nextItem])
}

function makeMovementPairs(items) {
  return items
    .slice(0, -1)
    .map((item, index) => [item, items[index + 1]])
    .filter(([from, to]) => typeof from.lat === 'number' && typeof to.lat === 'number')
}

function getRouteMode(from, to) {
  const latDiff = (to.lat - from.lat) * 111
  const lngDiff = (to.lng - from.lng) * 91
  const km = Math.sqrt(latDiff ** 2 + lngDiff ** 2)
  return km <= 1.5 ? 'walking' : 'driving'
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

function GooglePlaceField({
  disabled,
  mapsReady,
  onSelect,
  onValueChange,
  value,
}) {
  const [predictions, setPredictions] = useState([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const autocompleteRef = useRef(null)
  const placesRef = useRef(null)
  const tokenRef = useRef(null)

  useEffect(() => {
    if (!mapsReady || !window.google?.maps?.places) return
    autocompleteRef.current = new window.google.maps.places.AutocompleteService()
    placesRef.current = new window.google.maps.places.PlacesService(document.createElement('div'))
    tokenRef.current = new window.google.maps.places.AutocompleteSessionToken()
  }, [mapsReady])

  useEffect(() => {
    if (!mapsReady || disabled || !value.trim() || !autocompleteRef.current) {
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
          componentRestrictions: { country: 'jp' },
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

        tokenRef.current = new window.google.maps.places.AutocompleteSessionToken()
        setPredictions([])
        onSelect({
          placeId: place.place_id || '',
          locationName: place.name || prediction.structured_formatting?.main_text || value,
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
          onChange={(event) => onValueChange(event.target.value)}
          disabled={disabled || !mapsReady}
          placeholder="Search with Google Maps"
          className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
        />
        <div className="flex w-12 items-center justify-center rounded-2xl bg-slate-900 text-white">
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </div>
      </div>

      <div className="text-xs text-slate-500">
        Select a Google Places suggestion to attach a reliable map pin.
      </div>

      {error ? (
        <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div>
      ) : null}

      {predictions.length ? (
        <div className="space-y-2 rounded-2xl bg-slate-50 p-3">
          {predictions.map((prediction) => (
            <button
              key={prediction.place_id}
              type="button"
              onClick={() => selectPrediction(prediction)}
              className="block w-full rounded-2xl bg-white px-4 py-3 text-left"
            >
              <div className="text-sm font-semibold text-slate-900">
                {prediction.structured_formatting?.main_text || prediction.description}
              </div>
              <div className="mt-1 text-xs text-slate-500">
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
      <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
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
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <div
        className={`glass-panel w-full border border-white/60 p-6 ${
          isMobilePortrait ? 'rounded-[2rem] sm:max-w-md' : 'max-w-3xl rounded-[2rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-900">Manage days</h3>
            <p className="mt-1 text-sm text-slate-600">
              Reorder, rename, edit dates, add, or delete trip days.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {days.map((day, index) => (
            <div
              key={day.id}
              className={`rounded-[1.5rem] bg-white p-4 shadow-sm ${
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
              <div className="mt-2 text-sm text-slate-500">{buildDayLabel(day, index)}</div>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-[1.5rem] bg-slate-50 p-4">
          <div className="text-sm font-semibold text-slate-900">Add day</div>
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
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <div
        className={`glass-panel w-full border border-white/60 p-6 ${
          isMobilePortrait ? 'rounded-[2rem] sm:max-w-md' : 'max-w-lg rounded-[2rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-900">{item.title}</h3>
            <p className="mt-1 text-sm text-slate-600">{item.locationName || item.address}</p>
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

        <div className="mt-5 space-y-4">
          <div className="rounded-2xl bg-white px-4 py-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Notes</div>
            <div className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
              {item.generated
                ? 'This hotel stop stays linked to the previous day hotel. You can still adjust time, notes, and booking details here.'
                : item.description || 'No notes yet.'}
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
          {item.generated ? 'View linked details' : 'Open details'}
        </button>
      </div>
    </div>
  )
}

function DetailModal({
  autosaveStatus,
  dayOptions,
  detailItem,
  firestoreReady,
  isGenerated,
  isMobilePortrait,
  mapsReady,
  onChange,
  onClose,
  onDelete,
}) {
  const fieldReadOnly = !firestoreReady
  const linkedLocked = isGenerated

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/50 p-4 backdrop-blur-sm sm:items-center sm:justify-center">
      <div
        className={`glass-panel w-full border border-white/60 p-6 ${
          isMobilePortrait ? 'rounded-[2rem] sm:max-w-md' : 'max-w-2xl rounded-[2rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-900">{detailItem.title}</h3>
            <div className="mt-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {autosaveStatus === 'saving' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              {isGenerated
                ? 'Linked hotel item'
                : autosaveStatus === 'saving'
                  ? 'Autosaving...'
                  : autosaveStatus === 'error'
                    ? 'Save failed'
                    : 'All changes synced'}
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
          <div className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-700">
            This stop stays linked to the previous day hotel for place continuity. You can still edit its time, notes, and booking reference here.
          </div>
        ) : null}

        <div className={`mt-5 grid gap-4 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
          <Field label="Day">
            <select
              value={detailItem.dayId}
              onChange={(event) => onChange({ dayId: event.target.value })}
              disabled={fieldReadOnly || linkedLocked}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
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
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input
              value={detailItem.title}
              onChange={(event) => onChange({ title: event.target.value })}
              disabled={fieldReadOnly || linkedLocked}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
          <Field label="Start time">
            <input
              type="time"
              value={detailItem.startTime}
              onChange={(event) => onChange({ startTime: event.target.value })}
              disabled={fieldReadOnly}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
          <Field label="End time">
            <input
              type="time"
              value={detailItem.endTime}
              onChange={(event) => onChange({ endTime: event.target.value })}
              disabled={fieldReadOnly}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
        </div>

        <div className="mt-4 space-y-3">
          <PlaceFields
            draft={detailItem}
            disabled={fieldReadOnly || linkedLocked}
            mapsReady={mapsReady}
            onChange={onChange}
          />

          <Field label="Booking ref">
            <input
              value={detailItem.bookingRef || ''}
              onChange={(event) => onChange({ bookingRef: event.target.value })}
              disabled={fieldReadOnly}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
          <Field label="Notes">
            <textarea
              rows={5}
              value={detailItem.description || ''}
              onChange={(event) => onChange({ description: event.target.value })}
              disabled={fieldReadOnly}
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
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
          className={`mt-5 flex items-center justify-between rounded-2xl px-4 py-4 text-sm font-bold ${
            typeof detailItem.lat === 'number' && typeof detailItem.lng === 'number'
              ? 'bg-indigo-600 text-white'
              : 'pointer-events-none bg-slate-100 text-slate-400'
          }`}
        >
          Open in Google Maps
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
    </div>
  )
}

function PlannerPanel({
  activeDayId,
  dayOptions,
  filteredItems,
  firestoreReady,
  isMobilePortrait,
  mapsReady,
  onDayChange,
  onManageDays,
  onOpenDetails,
  onOpenNotes,
  onSaveNewItem,
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
  const effectiveDraftDayId =
    activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)
      ? activeDayId
      : draft.dayId && dayOptions.some((day) => day.id === draft.dayId)
        ? draft.dayId
        : dayOptions[0]?.id || ''
  const [isComposerOpen, setIsComposerOpen] = useState(activeDayId !== DAY_VIEW_ALL)

  async function saveNewItem() {
    if (!firestoreReady || !effectiveDraftDayId) return

    await onSaveNewItem({
      ...draft,
      dayId: effectiveDraftDayId,
      id: slugId('item'),
    })

    setDraft(buildEmptyDraft(activeDayId !== DAY_VIEW_ALL ? activeDayId : dayOptions[0]?.id || ''))
    setIsComposerOpen(false)
  }

  return (
    <>
      <div className="sticky top-4 z-20 space-y-3">
        <div className="glass-panel rounded-[1.65rem] border border-white/60 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="headline text-[2rem] leading-none text-slate-900">
                {activeDayId === DAY_VIEW_ALL
                  ? 'Full itinerary'
                  : dayOptions.find((day) => day.id === activeDayId)?.label || 'Day view'}
              </h2>
              <div className="mt-1 text-sm text-slate-500">
                {activeDayId === DAY_VIEW_ALL
                  ? `${filteredItems.length} stops across ${dayOptions.length} days`
                  : dayOptions.find((day) => day.id === activeDayId)?.name ||
                    formatFullDayDate(dayOptions.find((day) => day.id === activeDayId)?.date || '')}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="rounded-full bg-white px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Tap notes · Hold details
              </div>
              <button
                type="button"
                onClick={onManageDays}
                className="rounded-[1.2rem] bg-slate-900 px-4 py-3 text-sm font-semibold text-white"
              >
                Manage days
              </button>
            </div>
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => onDayChange(DAY_VIEW_ALL)}
              className={`min-w-[108px] rounded-[1.1rem] px-4 py-3 text-left transition ${
                activeDayId === DAY_VIEW_ALL ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'
              }`}
            >
              <div className="text-sm font-semibold">Overview</div>
              <div className={`mt-1 text-[11px] ${activeDayId === DAY_VIEW_ALL ? 'text-white/65' : 'text-slate-400'}`}>
                Whole trip
              </div>
            </button>
            {dayOptions.map((day, index) => (
              <button
                key={day.id}
                type="button"
                onClick={() => onDayChange(day.id)}
                className={`min-w-[150px] rounded-[1.1rem] px-4 py-3 text-left transition ${
                  activeDayId === day.id ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'
                }`}
              >
                <div className="text-sm font-semibold">Day {index + 1}</div>
                <div className={`mt-1 text-[11px] ${activeDayId === day.id ? 'text-white/65' : 'text-slate-400'}`}>
                  {day.date.slice(5).replace('-', '/')}
                </div>
              </button>
            ))}
          </div>

          {weatherDisplay ? (
            <div className="mt-4 flex items-center justify-between gap-4 rounded-[1.2rem] bg-white px-4 py-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">Weather</p>
                <div className="mt-1 text-base font-semibold text-slate-900">{weatherDisplay.headline}</div>
                <div className="mt-1 text-sm text-slate-500">{weatherDisplay.detail}</div>
              </div>
              <div className="rounded-2xl bg-slate-100 p-3 text-slate-700">
                <weatherDisplay.icon className="h-5 w-5" />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        {filteredItems.map((item, index) => {
          const meta = typeMeta(item.category)
          const nextSegment = routeSegments[index]
          return (
            <div key={item.id} className="space-y-2">
              <article
                className="timeline-card relative rounded-[1.45rem] px-4 py-4 transition hover:bg-white/90 active:bg-white/95 sm:px-5"
                onClick={() => onOpenNotes(item)}
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => onOpenDetails.startPress(event, item)}
                onPointerMove={onOpenDetails.movePress}
                onPointerUp={(event) => onOpenDetails.endPress(event, item)}
                onPointerCancel={onOpenDetails.cancelPress}
                onPointerLeave={onOpenDetails.cancelPress}
              >
                <div className="flex gap-4 sm:gap-5">
                  <div className="w-16 shrink-0 pt-0.5 text-right">
                    <div className="text-sm font-semibold text-slate-900">{item.startTime}</div>
                    {item.endTime ? <div className="mt-1 text-[11px] text-slate-400">{item.endTime}</div> : null}
                  </div>
                  <div className="timeline-rail shrink-0">
                    <span className={`timeline-dot ${meta.tone}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-[1.02rem] font-semibold leading-6 text-slate-900">{item.title}</h3>
                        <p className="mt-1 truncate text-sm text-slate-500">{item.locationName || item.address}</p>
                      </div>
                      {item.generated ? (
                        <div className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-700">
                          Linked
                        </div>
                      ) : null}
                    </div>
                    {item.address && item.address !== item.locationName ? (
                      <p className="mt-1 truncate text-xs text-slate-400">{item.address}</p>
                    ) : null}
                    {(item.description || item.generated) ? (
                      <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-500">
                        {item.generated ? 'Auto-carried from the previous day hotel stay.' : item.description}
                      </p>
                    ) : null}
                  </div>
                </div>
              </article>

              {nextSegment ? (
                <div className="ml-20 flex items-center gap-3 rounded-[1rem] px-4 py-2 text-xs text-slate-500 sm:ml-[6.1rem]">
                  <span className="font-medium text-slate-700">{routeLabel(nextSegment.mode)}</span>
                  <span>
                    {nextSegment.route
                      ? `${Math.round(nextSegment.route.durationMin)} min`
                      : 'Loading route'}
                  </span>
                  {nextSegment.route ? <span>{nextSegment.route.distanceKm.toFixed(1)} km</span> : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="glass-panel rounded-[1.6rem] border border-white/60 px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="headline text-[1.9rem] leading-none text-slate-900">Add stop</h3>
            <p className="mt-1 text-sm text-slate-500">Keep this tucked away until you need it.</p>
          </div>
          <button
            type="button"
            onClick={() => setIsComposerOpen((open) => !open)}
            className={`rounded-[1.15rem] px-4 py-3 text-sm font-semibold transition ${
              isComposerOpen ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'
            }`}
          >
            {isComposerOpen ? 'Hide form' : 'New stop'}
          </button>
        </div>

        {isComposerOpen ? (
          <>
            <div className={`mt-5 grid gap-4 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
              <Field label="Day">
                <select
                  value={effectiveDraftDayId}
                  onChange={(event) => setDraft((current) => ({ ...current, dayId: event.target.value }))}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
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
                  onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                >
                  {CATEGORY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Title">
                <input
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Start time">
                <input
                  type="time"
                  value={draft.startTime}
                  onChange={(event) => setDraft((current) => ({ ...current, startTime: event.target.value }))}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="End time">
                <input
                  type="time"
                  value={draft.endTime}
                  onChange={(event) => setDraft((current) => ({ ...current, endTime: event.target.value }))}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
            </div>

            <div className="mt-4 space-y-3">
              <PlaceFields
                draft={draft}
                disabled={!firestoreReady}
                mapsReady={mapsReady}
                onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
              />

              <Field label="Notes">
                <textarea
                  rows={3}
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Booking ref">
                <input
                  value={draft.bookingRef}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, bookingRef: event.target.value }))
                  }
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                />
              </Field>
            </div>

            <button
              type="button"
              onClick={() => void saveNewItem()}
              disabled={!firestoreReady || !effectiveDraftDayId}
              className="mt-5 w-full rounded-[1.25rem] bg-slate-900 px-4 py-4 text-sm font-bold text-white disabled:bg-slate-300"
            >
              Save new itinerary detail
            </button>
          </>
        ) : (
          <div className="mt-4 rounded-[1.1rem] bg-white px-4 py-3 text-sm text-slate-500">
            Open the composer only when you need to add a new stop.
          </div>
        )}
      </div>
    </>
  )
}

function MapPanel({ activeDayId, filteredItems, isMobilePortrait, mapsReady, mapsError, routeSegments }) {
  return (
    <div className="space-y-3">
      <div className="glass-panel rounded-[1.6rem] border border-white/60 px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="headline text-[1.9rem] leading-none text-slate-900">Map</h2>
            <p className="mt-1 text-sm text-slate-500">
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
              <TripMap filteredItems={filteredItems} routeSegments={routeSegments} />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center bg-slate-100 px-6 text-center text-sm font-medium text-slate-500">
              {mapsError || 'Add VITE_GOOGLE_MAPS_API_KEY to enable Google Maps.'}
            </div>
          )}
        </div>
      </div>

      <div className="glass-panel rounded-[1.6rem] border border-white/60 px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">Movement</h3>
          <span className="text-xs text-slate-400">{routeSegments.length} legs</span>
        </div>
        <div className="mt-3 space-y-2">
          {routeSegments.length ? (
            routeSegments.map((segment) => (
              <div key={segment.id} className="rounded-[1.1rem] bg-white px-4 py-3">
                <div className="truncate text-sm font-medium text-slate-800">
                  {segment.from.title} → {segment.to.title}
                </div>
                <div className="mt-1 flex gap-3 text-xs text-slate-500">
                  <span>{routeLabel(segment.mode)}</span>
                  <span>
                    {segment.route ? `${Math.round(segment.route.durationMin)} min` : 'Loading route'}
                  </span>
                  {segment.route ? <span>{segment.route.distanceKm.toFixed(1)} km</span> : null}
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-[1.1rem] bg-white px-4 py-3 text-sm text-slate-500">
              Add more locations to visualize movement between stops.
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
  const [overrides, setOverrides] = useState({ days: {}, items: {} })
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
  const [showDayManager, setShowDayManager] = useState(false)

  const isMobilePortrait = useResponsiveMode()
  const routeCacheRef = useRef(new Map())
  const debounceRef = useRef(null)
  const pressStateRef = useRef({
    timer: null,
    pointerId: null,
    itemId: null,
    startX: 0,
    startY: 0,
    moved: false,
    longPressed: false,
  })

  const tripState = useMemo(() => deriveTripState(overrides), [overrides])
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
        unsubscribe = await subscribeToTripState(
          (payload) => {
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
    if (!detailItem || !firestoreReady) return

    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    debounceRef.current = window.setTimeout(async () => {
      try {
        if (detailItem.generated) {
          await mergeTripPatch({
            items: {
              [detailItem.id]: generatedItemPatch(detailItem),
            },
          })
        } else {
          const sameDayItems = tripState.items.filter(
            (item) => item.dayId === detailItem.dayId && !item.generated && item.id !== detailItem.id,
          )
          const patchItems = Object.fromEntries(
            mergeItemsForDay(sameDayItems, detailItem).map((item) => [item.id, item]),
          )
          await mergeTripPatch({ items: patchItems })
        }
        setAutosaveStatus('saved')
      } catch (error) {
        console.error(error)
        setAutosaveStatus('error')
      }
    }, SAVE_DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [detailItem, firestoreReady, tripState.items])

  const routePairs = useMemo(() => makeMovementPairs(deferredItems), [deferredItems])

  useEffect(() => {
    let cancelled = false
    if (!googleMapsState.ready || !window.google?.maps || !routePairs.length) return undefined

    async function loadRoutes() {
      const directionsService = new window.google.maps.DirectionsService()
      const entries = await Promise.all(
        routePairs.map(async ([from, to]) => {
          const mode = getRouteMode(from, to)
          const key = `${from.id}:${to.id}:${mode}`
          const cached = routeCacheRef.current.get(key)
          if (cached) return [key, cached]

          try {
            const result = await new Promise((resolve, reject) => {
              directionsService.route(
                {
                  origin: { lat: from.lat, lng: from.lng },
                  destination: { lat: to.lat, lng: to.lng },
                  travelMode:
                    mode === 'walking'
                      ? window.google.maps.TravelMode.WALKING
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

            const summary = toRouteSummary(result, mode)
            routeCacheRef.current.set(key, summary)
            return [key, summary]
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
  }, [googleMapsState.ready, routePairs])

  const routeSegments = useMemo(
    () =>
      deferredItems.slice(0, -1).map((item, index) => {
        const next = deferredItems[index + 1]
        const mode = getRouteMode(item, next)
        const key = `${item.id}:${next.id}:${mode}`
        return { id: key, from: item, to: next, route: routeMap[key], mode }
      }),
    [deferredItems, routeMap],
  )

  async function saveItem(item) {
    const sameDayItems = tripState.items.filter(
      (existing) => existing.dayId === item.dayId && !existing.generated && existing.id !== item.id,
    )
    const patchItems = Object.fromEntries(
      mergeItemsForDay(sameDayItems, item).map((entry) => [entry.id, entry]),
    )
    await mergeTripPatch({ items: patchItems })
  }

  async function updateDay(dayId, changes) {
    if (changes.date) {
      const duplicate = visibleDays.find((day) => day.id !== dayId && day.date === changes.date)
      if (duplicate) {
        window.alert('Each day needs a unique date.')
        return
      }
    }
    await mergeTripPatch({ days: { [dayId]: changes } })
  }

  async function addDay(draft) {
    if (!firestoreReady || !draft.date) return
    if (visibleDays.some((day) => day.date === draft.date)) {
      window.alert('That date already exists in the itinerary.')
      return
    }

    const id = slugId('day')
    await mergeTripPatch({
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
    await mergeTripPatch({
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
    await mergeTripPatch({
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
    await mergeTripPatch({ items: { [itemId]: { hidden: true } } })
    setNoteItem((current) => (current?.id === itemId ? null : current))
    setDetailItem((current) => (current?.id === itemId ? null : current))
  }

  function openNotes(item) {
    setNoteItem(item)
  }

  function openDetails(item) {
    setAutosaveStatus('saved')
    setDetailItem({ ...item })
  }

  function updateDetail(changes) {
    setAutosaveStatus('saving')
    setDetailItem((current) => (current ? { ...current, ...changes } : current))
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
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-5 pb-8 text-slate-900 sm:px-6 sm:pb-10 lg:px-8">
      <section className="glass-panel rounded-[2rem] border border-white/60 px-5 py-5 sm:px-7">
        <div className="flex items-center justify-between gap-4">
          <h1 className="headline text-3xl leading-tight sm:text-5xl">Trip planner</h1>
          <div className="flex flex-wrap items-center gap-2">
            {!MAPS_API_KEY ? (
              <div className="rounded-full bg-amber-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Google Maps key missing
              </div>
            ) : null}
            {firestoreState.status === 'error' ? (
              <div className="rounded-full bg-rose-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-rose-600">
                Firestore error
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section
        className={
          isMobilePortrait
            ? 'mx-auto mt-6 max-w-md space-y-4'
            : 'mt-6 grid gap-6 lg:grid-cols-[1.08fr_0.92fr]'
        }
      >
        <div className="space-y-4">
          <PlannerPanel
            activeDayId={resolvedActiveDayId}
            dayOptions={dayOptions}
            filteredItems={filteredItems}
            firestoreReady={firestoreReady}
            isMobilePortrait={isMobilePortrait}
            mapsReady={googleMapsState.ready}
            onDayChange={(dayId) => {
              startTransition(() => {
                setActiveDayId(dayId)
              })
            }}
            onManageDays={() => setShowDayManager(true)}
            onOpenDetails={{
              startPress,
              movePress,
              endPress,
              cancelPress: clearPressState,
            }}
            onOpenNotes={openNotes}
            onSaveNewItem={saveItem}
            routeSegments={routeSegments}
            selectedWeather={selectedWeather}
            weatherState={weatherState}
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
          autosaveStatus={autosaveStatus}
          dayOptions={dayOptions}
          detailItem={detailItem}
          firestoreReady={firestoreReady}
          isGenerated={Boolean(detailItem.generated)}
          isMobilePortrait={isMobilePortrait}
          mapsReady={googleMapsState.ready}
          onChange={updateDetail}
          onClose={() => setDetailItem(null)}
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
