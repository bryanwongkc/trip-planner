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
  Download,
  LogOut,
  Pencil,
  Footprints,
  ExternalLink,
  Loader2,
  Menu,
  Plus,
  Search,
  Sun,
  Trash2,
  Users,
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
  SEED_ITEMS,
  TRIP_ID,
} from './data/seedItinerary'
import {
  addTripMember,
  createTripRecordWithOwner,
  ensureUserProfile,
  firebaseEnabled,
  lookupUserByEmail,
  mergeTripPatch,
  removeTripMember,
  signInWithGoogle,
  signOutUser,
  subscribeToAuthState,
  subscribeToTripMembers,
  subscribeToTripState,
  subscribeToUserTripDirectory,
  updateTripMemberRole,
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
  stripFlightLocationFields,
  timeToMinutes,
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
const TRANSIT_MODE_OPTIONS = [
  { value: 'train', label: 'Train' },
  { value: 'bus', label: 'Bus' },
  { value: 'ferry', label: 'Ferry' },
  { value: 'taxi', label: 'Taxi' },
  { value: 'other', label: 'Other' },
]
const DURATION_PRESETS = [
  { label: '30m', value: 30 },
  { label: '45m', value: 45 },
  { label: '1h', value: 60 },
  { label: '1h30', value: 90 },
  { label: '2h', value: 120 },
  { label: '3h', value: 180 },
]

function canViewTrip(role) {
  return ['owner', 'editor', 'viewer'].includes(role)
}

function canEditTrip(role) {
  return ['owner', 'editor'].includes(role)
}

function canManageMembers(role) {
  return role === 'owner'
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
  if (category === 'Flight') return { tone: 'bg-sky-50 text-sky-600', card: 'timeline-card--flight' }
  if (category === 'Car') return { tone: 'bg-indigo-50 text-indigo-600', card: 'timeline-card--transport' }
  if (category === 'Transport') return { tone: 'bg-indigo-50 text-indigo-600', card: 'timeline-card--transport' }
  if (category === 'Hotel') return { tone: 'bg-amber-50 text-amber-600', card: 'timeline-card--hotel' }
  if (category === 'Restaurant') return { tone: 'bg-orange-50 text-orange-600', card: 'timeline-card--restaurant' }
  if (category === 'Wedding') return { tone: 'bg-pink-50 text-pink-600', card: 'timeline-card--event' }
  if (category === 'Others') return { tone: 'bg-slate-100 text-slate-600', card: 'timeline-card--other' }
  return { tone: 'bg-emerald-50 text-emerald-600', card: 'timeline-card--activity' }
}

function categoryOptionsForValue(category) {
  if (!category || CATEGORY_OPTIONS.includes(category)) return CATEGORY_OPTIONS
  return [category, ...CATEGORY_OPTIONS]
}

function defaultTransitDetails() {
  return {
    mode: 'train',
    from: '',
    to: '',
    lineName: '',
    serviceNumber: '',
    platform: '',
    approxDurationMinutes: '',
    notes: '',
  }
}

function normalizeTransitDetails(transit = {}) {
  const source = transit || {}
  return {
    ...defaultTransitDetails(),
    ...source,
    approxDurationMinutes:
      source.approxDurationMinutes === 0 || source.approxDurationMinutes
        ? String(source.approxDurationMinutes)
        : '',
  }
}

function normalizeTransitForItem(item) {
  if (item?.category !== 'Transport') return { ...item, transit: null }
  return { ...item, transit: normalizeTransitDetails(item.transit) }
}

function transitModeLabel(mode) {
  return TRANSIT_MODE_OPTIONS.find((option) => option.value === mode)?.label || 'Transit'
}

function buildTransitSummary(item) {
  if (item?.category !== 'Transport') return ''
  const transit = normalizeTransitDetails(item.transit)
  const primary = [
    transitModeLabel(transit.mode),
    transit.lineName,
    transit.serviceNumber,
    transit.platform ? `Platform ${transit.platform}` : '',
  ].filter(Boolean)
  const route = [transit.from, transit.to].filter(Boolean).join(' to ')
  const duration = transit.approxDurationMinutes ? `~${transit.approxDurationMinutes} min` : ''

  return [primary.join(' · '), route, duration].filter(Boolean).join(' · ')
}

function itemLocationSummary(item) {
  return item?.locationName || item?.address || ''
}

function isStackableStayOrMeal(item) {
  return ['Hotel', 'Restaurant'].includes(item?.category)
}

function itemInterval(item) {
  const start = timeToMinutes(item?.startTime || '23:59')
  const rawEnd = item?.endTime ? timeToMinutes(item.endTime) : start + 1
  return {
    start,
    end: rawEnd > start ? rawEnd : start + 1,
  }
}

function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end
}

function hasActiveStayOrMealStatus(item) {
  return item?.status === 'active'
}

function chooseStackLead(items) {
  return [...items].sort((a, b) => {
    const activeCompare = Number(hasActiveStayOrMealStatus(b)) - Number(hasActiveStayOrMealStatus(a))
    if (activeCompare !== 0) return activeCompare
    return itemInterval(a).start - itemInterval(b).start
  })[0]
}

function buildTimelineEntries(items) {
  const stackByItemId = new Map()

  Object.values(
    items.filter(isStackableStayOrMeal).reduce((groups, item) => {
      const key = `${item.dayId}:${item.category}`
      groups[key] = groups[key] || []
      groups[key].push(item)
      return groups
    }, {}),
  ).forEach((groupItems) => {
    const ordered = [...groupItems].sort((a, b) => itemInterval(a).start - itemInterval(b).start)
    const clusters = []

    ordered.forEach((item) => {
      const interval = itemInterval(item)
      const cluster = clusters.find((entry) =>
        entry.items.some((candidate) => intervalsOverlap(interval, itemInterval(candidate))),
      )

      if (cluster) {
        cluster.items.push(item)
        return
      }

      clusters.push({ items: [item] })
    })

    clusters
      .filter((cluster) => cluster.items.length > 1)
      .forEach((cluster) => {
        const leadItem = chooseStackLead(cluster.items)
        const stack = {
          id: `stack:${leadItem.dayId}:${leadItem.category}:${cluster.items.map((item) => item.id).sort().join(':')}`,
          type: 'stack',
          dayId: leadItem.dayId,
          item: leadItem,
          items: [leadItem, ...cluster.items.filter((item) => item.id !== leadItem.id)],
        }
        cluster.items.forEach((item) => stackByItemId.set(item.id, stack))
      })
  })

  const emittedStacks = new Set()
  return items.flatMap((item) => {
    const stack = stackByItemId.get(item.id)
    if (!stack) return [{ id: item.id, type: 'item', dayId: item.dayId, item, items: [item] }]
    if (emittedStacks.has(stack.id)) return []
    emittedStacks.add(stack.id)
    return [stack]
  })
}

function isMonitoredCancellationItem(item) {
  return !item?.generated && ['Hotel', 'Restaurant'].includes(item?.category)
}

function isHeldBookingOption(booking) {
  return booking && !booking.hidden && booking.status !== 'cancelled'
}

function isHeldStackableItineraryItem(item) {
  return isStackableStayOrMeal(item) && !item.generated && !item.hidden && item.status !== 'cancelled'
}

function fallbackBookingGroupKey(booking) {
  return [
    booking.dayId || 'day',
    booking.type || 'booking',
    booking.reservationTime || booking.startDate || '',
    booking.endDate || '',
    (booking.title || '').trim().toLowerCase(),
  ].join('|')
}

function getOverbookingMetaForItem({ bookingOptions = [], itemId }) {
  const heldBookings = bookingOptions.filter(
    (booking) => booking.linkedItemId === itemId && isHeldBookingOption(booking),
  )
  const activeCount = heldBookings.length

  return {
    activeCount,
    excessCount: Math.max(0, activeCount - 1),
    isOverbooked: activeCount > 1,
    nextDeadline:
      heldBookings
        .filter((booking) => booking.cancellationDeadline)
        .sort((a, b) => new Date(a.cancellationDeadline).getTime() - new Date(b.cancellationDeadline).getTime())[0] ||
      null,
  }
}

function getBookingOptionOverbookingCountForDay({ bookingOptions = [], items = [], dayId }) {
  const itemDayLookup = Object.fromEntries(items.map((item) => [item.id, item.dayId]))
  const groups = new Map()

  bookingOptions.forEach((booking) => {
    if (!isHeldBookingOption(booking)) return
    const bookingDayId = booking.linkedItemId ? itemDayLookup[booking.linkedItemId] || booking.dayId : booking.dayId
    if (bookingDayId !== dayId) return
    const groupKey = booking.linkedItemId || fallbackBookingGroupKey(booking)
    groups.set(groupKey, (groups.get(groupKey) || 0) + 1)
  })

  return [...groups.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
}

function getItineraryStackOverbookingCountForDay({ items = [], dayId }) {
  return buildTimelineEntries(items.filter((item) => item.dayId === dayId && isHeldStackableItineraryItem(item)))
    .filter((entry) => entry.type === 'stack')
    .reduce((total, entry) => total + Math.max(0, entry.items.length - 1), 0)
}

function getOverbookingCountForDay({ bookingOptions = [], items = [], dayId }) {
  return (
    getBookingOptionOverbookingCountForDay({ bookingOptions, items, dayId }) +
    getItineraryStackOverbookingCountForDay({ items, dayId })
  )
}

function getOverbookingCountsByDay({ bookingOptions = [], items = [] }) {
  const dayIds = new Set([
    ...items.map((item) => item.dayId).filter(Boolean),
    ...bookingOptions.map((booking) => booking.dayId).filter(Boolean),
  ])

  return Object.fromEntries(
    [...dayIds].map((dayId) => [
      dayId,
      getOverbookingCountForDay({ bookingOptions, items, dayId }),
    ]),
  )
}

function formatBadgeCount(count) {
  return count > 9 ? '9+' : String(count)
}

function cancellationStateForItem(item, now = new Date()) {
  if (!item?.cancellationDeadline) return 'no_deadline'
  const deadline = new Date(item.cancellationDeadline)
  if (Number.isNaN(deadline.getTime())) return 'invalid_deadline'
  const diffMs = deadline.getTime() - now.getTime()
  if (diffMs < 0) return 'overdue'
  if (diffMs <= 3 * 24 * 60 * 60 * 1000) return 'within_3_days'
  return 'later'
}

function deadlineDayDistance(value, now = new Date()) {
  if (!value) return null
  const deadline = new Date(value)
  if (Number.isNaN(deadline.getTime())) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const deadlineDay = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate())
  return Math.round((deadlineDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
}

function cancellationUrgencyMeta(item) {
  const state = cancellationStateForItem(item)
  const days = deadlineDayDistance(item?.cancellationDeadline)

  if (state === 'overdue') {
    return {
      label: 'Overdue',
      note: 'Action needed',
      card: 'border-rose-200 bg-rose-50/85',
      rail: 'bg-rose-500',
      badge: 'bg-rose-100 text-rose-700',
      deadline: 'text-rose-700',
    }
  }

  if (state === 'within_3_days') {
    const label = days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `${days} days left`
    return {
      label,
      note: 'Cancel soon',
      card: 'border-amber-200 bg-amber-50/80',
      rail: 'bg-amber-500',
      badge: 'bg-amber-100 text-amber-800',
      deadline: 'text-amber-800',
    }
  }

  if (state === 'no_deadline') {
    return {
      label: 'No deadline',
      note: 'Add date',
      card: 'border-slate-200 bg-white',
      rail: 'bg-slate-300',
      badge: 'bg-slate-100 text-slate-600',
      deadline: 'text-slate-500',
    }
  }

  if (state === 'invalid_deadline') {
    return {
      label: 'Check date',
      note: 'Invalid',
      card: 'border-slate-200 bg-white',
      rail: 'bg-slate-400',
      badge: 'bg-slate-100 text-slate-600',
      deadline: 'text-slate-600',
    }
  }

  return {
    label: days ? `${days} days left` : 'Scheduled',
    note: itemStatusLabel(item?.status),
    card: 'border-slate-200 bg-white',
    rail: 'bg-slate-300',
    badge: 'bg-slate-100 text-slate-600',
    deadline: 'text-slate-900',
  }
}

function formatItemBookingDateTime(item) {
  const dateLabel = item?.dayDate ? formatDayDate(item.dayDate) : item?.dayLabel || 'Date unset'
  const timeLabel = item?.startTime
    ? `${item.startTime}${item.endTime ? `-${item.endTime}` : ''}`
    : 'Time unset'
  return `${dateLabel} · ${timeLabel}`
}

function sortedCancellationItems(items) {
  return items
    .filter(isMonitoredCancellationItem)
    .sort((a, b) => {
      const aTime = a.cancellationDeadline ? new Date(a.cancellationDeadline).getTime() : Infinity
      const bTime = b.cancellationDeadline ? new Date(b.cancellationDeadline).getTime() : Infinity
      if (aTime !== bTime) return aTime - bTime
      return compareTime(a.startTime || '23:59', b.startTime || '23:59')
    })
}

function routeLabel(mode) {
  if (mode === 'transit') return 'Transit'
  return mode === 'walking' ? 'Walk' : 'Drive'
}

function getGoogleMapsUrl(item) {
  if (!item) return ''
  if (typeof item.lat === 'number' && typeof item.lng === 'number') {
    return `https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}`
  }

  const query = item.address || item.locationName || item.title || ''
  if (!query) return ''

  if (item.placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}&query_place_id=${encodeURIComponent(item.placeId)}`
  }

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
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
    status: 'considering',
    cancellationDeadline: '',
    transit: null,
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

function pdfSafeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function escapeHtml(value) {
  return pdfSafeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function exportFile(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function buildTripOverviewFilename(tripTitle) {
  const safeTitle = pdfSafeText(tripTitle)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
  return `${safeTitle || 'trip-overview'}-overview.pdf`
}

function exportItemsForDay(items, dayId) {
  const dayItems = items
    .filter((item) => item.dayId === dayId)
    .sort((a, b) => compareTime(a.startTime || '23:59', b.startTime || '23:59'))

  return buildTimelineEntries(dayItems).map((entry) => entry.item)
}

async function CREATE_TRIP_OVERVIEW_PDF_LEGACY({ days, items, tripSummary }) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const page = {
    width: doc.internal.pageSize.getWidth(),
    height: doc.internal.pageSize.getHeight(),
    marginX: 44,
    marginBottom: 48,
  }
  let y = 52

  const ensureSpace = (height = 24) => {
    if (y + height <= page.height - page.marginBottom) return
    doc.addPage()
    y = 48
  }

  const writeWrapped = (text, x, options = {}) => {
    const {
      color = [72, 84, 105],
      lineHeight = 14,
      maxWidth = page.width - x - page.marginX,
      size = 9,
      style = 'normal',
    } = options
    const cleanText = pdfSafeText(text)
    if (!cleanText) return 0
    doc.setFont('helvetica', style)
    doc.setFontSize(size)
    doc.setTextColor(...color)
    const lines = doc.splitTextToSize(cleanText, maxWidth)
    ensureSpace(lines.length * lineHeight)
    doc.text(lines, x, y)
    y += lines.length * lineHeight
    return lines.length * lineHeight
  }

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(24)
  doc.setTextColor(15, 23, 42)
  doc.text(pdfSafeText(tripSummary.title || 'Trip overview'), page.marginX, y)
  y += 22

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  doc.setTextColor(100, 116, 139)
  doc.text(formatTripDateRange(tripSummary.startDate, tripSummary.endDate), page.marginX, y)
  y += 30

  const itemsByDay = items.reduce((groups, item) => {
    groups[item.dayId] = groups[item.dayId] || []
    groups[item.dayId].push(item)
    return groups
  }, {})

  days.forEach((day, dayIndex) => {
    const dayItems = [...(itemsByDay[day.id] || [])].sort((a, b) => compareTime(a.startTime || '23:59', b.startTime || '23:59'))
    ensureSpace(72)
    doc.setDrawColor(226, 232, 240)
    doc.line(page.marginX, y, page.width - page.marginX, y)
    y += 22

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(15, 23, 42)
    doc.text(`${day.label || `Day ${dayIndex + 1}`} - ${formatFullDayDate(day.date)}`, page.marginX, y)
    y += 15

    if (day.name) {
      writeWrapped(day.name, page.marginX, { color: [100, 116, 139], size: 9, lineHeight: 12 })
      y += 5
    }

    if (!dayItems.length) {
      writeWrapped('No stops planned yet.', page.marginX, { color: [148, 163, 184], size: 9 })
      y += 8
      return
    }

    dayItems.forEach((item) => {
      ensureSpace(62)
      const timeLabel = item.endTime ? `${item.startTime || '--:--'}-${item.endTime}` : item.startTime || '--:--'
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(15, 23, 42)
      doc.text(timeLabel, page.marginX, y)

      const contentX = page.marginX + 82
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10.5)
      doc.setTextColor(15, 23, 42)
      doc.text(pdfSafeText(item.title || 'Untitled stop'), contentX, y)
      y += 14

      const locationLine = [item.category, item.locationName || item.address].filter(Boolean).join(' · ')
      writeWrapped(locationLine, contentX, { color: [100, 116, 139], size: 8.8, lineHeight: 12 })

      if (item.description) {
        writeWrapped(item.description, contentX, { color: [72, 84, 105], size: 8.8, lineHeight: 12 })
      }

      if (isMonitoredCancellationItem(item) && item.cancellationDeadline) {
        writeWrapped(`Cancellation: ${itemStatusLabel(item.status)} · ${formatBookingDateTime(item.cancellationDeadline)}`, contentX, {
          color: [190, 18, 60],
          size: 8.6,
          lineHeight: 12,
          style: 'bold',
        })
      }

      y += 8
    })
  })

  const pageCount = doc.getNumberOfPages()
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    doc.setPage(pageNumber)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(148, 163, 184)
    doc.text(`Generated from Trip Planner · Page ${pageNumber} of ${pageCount}`, page.marginX, page.height - 24)
  }

  return doc.output('blob')
}

async function createTripOverviewPdf({ days, items, tripSummary }) {
  const { jsPDF } = await import('jspdf')
  const html2canvas = (await import('html2canvas')).default
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()

  const dayHtml = days
    .map((day, dayIndex) => {
      const dayItems = exportItemsForDay(items, day.id)
      const stopsHtml = dayItems.length
        ? dayItems
            .map((item) => {
              const timeLabel = item.endTime
                ? `${item.startTime || '--:--'}-${item.endTime}`
                : item.startTime || '--:--'
              const locationLine = [item.category, item.locationName || item.address].filter(Boolean).join(' · ')
              const transitLine = buildTransitSummary(item)
              const deadlineLine =
                isMonitoredCancellationItem(item) && item.cancellationDeadline
                  ? `<div class="deadline">Cancellation: ${escapeHtml(itemStatusLabel(item.status))} · ${escapeHtml(formatBookingDateTime(item.cancellationDeadline))}</div>`
                  : ''

              return `
                <article class="stop">
                  <div class="time">${escapeHtml(timeLabel)}</div>
                  <div class="stop-body">
                    <div class="title">${escapeHtml(item.title || 'Untitled stop')}</div>
                    ${locationLine ? `<div class="meta">${escapeHtml(locationLine)}</div>` : ''}
                    ${transitLine ? `<div class="meta">${escapeHtml(transitLine)}</div>` : ''}
                    ${item.description ? `<div class="notes">${escapeHtml(item.description)}</div>` : ''}
                    ${deadlineLine}
                  </div>
                </article>
              `
            })
            .join('')
        : '<div class="empty">No stops planned yet.</div>'

      return `
        <section class="day">
          <div class="day-rule"></div>
          <div class="day-title">${escapeHtml(day.label || `Day ${dayIndex + 1}`)} - ${escapeHtml(formatFullDayDate(day.date))}</div>
          ${day.name ? `<div class="day-name">${escapeHtml(day.name)}</div>` : ''}
          <div class="stops">${stopsHtml}</div>
        </section>
      `
    })
    .join('')

  const container = document.createElement('div')
  container.style.cssText = 'position:absolute;left:-10000px;top:0;width:794px;background:#fffdfa;'
  container.innerHTML = `
    <div class="pdf-root">
      <style>
        .pdf-root {
          box-sizing: border-box;
          width: 794px;
          padding: 56px 58px 48px;
          background: #fffdfa;
          color: #0f172a;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic", "Hiragino Sans", "Microsoft YaHei", Arial, sans-serif;
        }
        .trip-title { font-size: 30px; line-height: 1.08; font-weight: 800; letter-spacing: -0.04em; }
        .trip-range { margin-top: 10px; color: #64748b; font-size: 13px; font-weight: 600; }
        .day { margin-top: 34px; break-inside: avoid; }
        .day-rule { height: 1px; background: #e2e8f0; margin-bottom: 20px; }
        .day-title { font-size: 17px; line-height: 1.25; font-weight: 800; letter-spacing: -0.02em; }
        .day-name { margin-top: 5px; color: #64748b; font-size: 12px; font-weight: 600; }
        .stops { margin-top: 16px; }
        .stop { display: grid; grid-template-columns: 82px 1fr; gap: 18px; padding: 11px 0; break-inside: avoid; }
        .time { color: #0f172a; font-size: 12px; font-weight: 800; letter-spacing: -0.01em; }
        .title { color: #0f172a; font-size: 14px; line-height: 1.35; font-weight: 800; letter-spacing: -0.02em; }
        .meta { margin-top: 4px; color: #64748b; font-size: 11px; line-height: 1.45; font-weight: 600; }
        .notes { margin-top: 5px; color: #475569; font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
        .deadline { margin-top: 6px; color: #be123c; font-size: 11px; line-height: 1.45; font-weight: 800; }
        .empty { color: #94a3b8; font-size: 12px; font-weight: 600; }
        .footer { margin-top: 36px; color: #94a3b8; font-size: 10px; font-weight: 600; }
      </style>
      <header>
        <div class="trip-title">${escapeHtml(tripSummary.title || 'Trip overview')}</div>
        <div class="trip-range">${escapeHtml(formatTripDateRange(tripSummary.startDate, tripSummary.endDate))}</div>
      </header>
      ${dayHtml}
      <div class="footer">Generated from Trip Planner</div>
    </div>
  `

  document.body.appendChild(container)

  try {
    const canvas = await html2canvas(container.firstElementChild, {
      backgroundColor: '#fffdfa',
      scale: Math.min(2, window.devicePixelRatio || 1.5),
      useCORS: true,
    })
    const sliceHeight = Math.floor((pageHeight * canvas.width) / pageWidth)
    let offsetY = 0
    let pageIndex = 0

    while (offsetY < canvas.height) {
      const currentSliceHeight = Math.min(sliceHeight, canvas.height - offsetY)
      const pageCanvas = document.createElement('canvas')
      pageCanvas.width = canvas.width
      pageCanvas.height = currentSliceHeight
      const context = pageCanvas.getContext('2d')
      context.drawImage(
        canvas,
        0,
        offsetY,
        canvas.width,
        currentSliceHeight,
        0,
        0,
        canvas.width,
        currentSliceHeight,
      )

      if (pageIndex > 0) doc.addPage()
      const imageHeight = (currentSliceHeight * pageWidth) / canvas.width
      doc.addImage(pageCanvas.toDataURL('image/png'), 'PNG', 0, 0, pageWidth, imageHeight)
      offsetY += currentSliceHeight
      pageIndex += 1
    }

    return doc.output('blob')
  } finally {
    container.remove()
  }
}

async function shareTripOverviewPdf({ days, items, tripSummary }) {
  const filename = buildTripOverviewFilename(tripSummary.title)
  const blob = await createTripOverviewPdf({ days, items, tripSummary })
  const file = new File([blob], filename, { type: 'application/pdf' })

  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: `${tripSummary.title || 'Trip'} overview`,
      text: 'Trip overview PDF',
    })
    return
  }

  exportFile(blob, filename)
}

function formatTripDateRange(startDate, endDate) {
  if (!startDate && !endDate) return 'No dates'
  if (startDate && endDate && startDate !== endDate) {
    return `${formatDayDate(startDate)} to ${formatDayDate(endDate)}`
  }
  return formatDayDate(startDate || endDate)
}

function localTodayIso() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function buildBlankTripSnapshot(date = localTodayIso()) {
  const dayId = slugId('day')

  return {
    startDate: date,
    endDate: date,
    days: {
      ...Object.fromEntries(SEED_DAYS.map((day) => [day.id, { ...day, hidden: true }])),
      [dayId]: {
        id: dayId,
        date,
        name: '',
        order: 0,
      },
    },
    items: Object.fromEntries(SEED_ITEMS.map((item) => [item.id, { ...item, hidden: true }])),
    bookingOptions: {},
  }
}

function formatBookingDateTime(value) {
  if (!value) return 'No deadline'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-HK', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDateTimeInputValue(value) {
  if (!value) return ''
  return String(value).slice(0, 16)
}

function itemStatusLabel(status) {
  return status === 'active' ? 'Active' : 'Considering'
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

function formatAirportLocalTimeToClock(value) {
  if (!value) return ''

  const localClock = String(value).match(/(?:T|\s)(\d{2}):(\d{2})/)
  if (localClock) return `${localClock[1]}:${localClock[2]}`

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
  const departureLabel = ''
  const arrivalLabel = ''

  return stripFlightLocationFields({
    ...item,
    category: 'Flight',
    flightCode,
    title: buildFlightTitle(record, flightCode),
    locationName: departureLabel && arrivalLabel ? `${departureLabel} → ${arrivalLabel}` : item.locationName,
    address: [departureLabel, arrivalLabel].filter(Boolean).join(' → ') || item.address,
    startTime: formatAirportLocalTimeToClock(record.scheduledDeparture) || item.startTime,
    endTime: formatAirportLocalTimeToClock(record.scheduledArrival) || item.endTime,
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
  })
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
  const normalized = normalizeTransitForItem(stripFlightLocationFields(normalizeItemTimeFields(item)))
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
  const cancellationFields = isMonitoredCancellationItem(nextItem)
    ? {
        status: nextItem.status || 'considering',
        cancellationDeadline: nextItem.cancellationDeadline || '',
      }
    : {
        status: '',
        cancellationDeadline: '',
      }

  if (Object.prototype.hasOwnProperty.call(patch, 'endTimeMode') && patch.endTimeMode === 'duration') {
    const derivedDuration =
      nextItem.durationMinutes ?? getDurationMinutes(nextItem.startTime, nextItem.endTime)

    return normalizeTransitForItem(stripFlightLocationFields(normalizeItemTimeFields({
      ...nextItem,
      ...cancellationFields,
      endTimeMode: 'duration',
      durationMinutes: derivedDuration,
    })))
  }

  return normalizeTransitForItem(stripFlightLocationFields(normalizeItemTimeFields({ ...nextItem, ...cancellationFields })))
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
    .filter(([, , fromItem, toItem]) => fromItem.category !== 'Flight' && toItem.category !== 'Flight')
    .filter(([fromPoint, toPoint]) => typeof fromPoint?.lat === 'number' && typeof toPoint?.lat === 'number')
    .map(([fromPoint, toPoint, fromItem, toItem]) => [fromPoint, toPoint, fromItem, toItem])
}

function buildMapItems(items) {
  return items
    .filter((item) => item.category !== 'Flight')
    .map((item, index) => {
      const nextItem = items[index + 1] || null

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
          className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
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

function TransitFields({ disabled, isMobilePortrait, transit, onChange }) {
  const value = normalizeTransitDetails(transit)
  const updateTransit = (changes) => onChange({ transit: normalizeTransitDetails({ ...value, ...changes }) })

  return (
    <div className="rounded-[1.15rem] border border-slate-200/80 bg-slate-50/70 p-3.5">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Transit details
      </div>
      <div className={`grid gap-3 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
        <Field label="Type">
          <select
            value={value.mode}
            onChange={(event) => updateTransit({ mode: event.target.value })}
            disabled={disabled}
            className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
          >
            {TRANSIT_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Approx duration">
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={value.approxDurationMinutes}
            onChange={(event) => updateTransit({ approxDurationMinutes: event.target.value })}
            disabled={disabled}
            placeholder="45 min"
            className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
          />
        </Field>
        <Field label="From station / stop">
          <input
            value={value.from}
            onChange={(event) => updateTransit({ from: event.target.value })}
            disabled={disabled}
            className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
          />
        </Field>
        <Field label="To station / stop">
          <input
            value={value.to}
            onChange={(event) => updateTransit({ to: event.target.value })}
            disabled={disabled}
            className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
          />
        </Field>
        <Field label="Line / route">
          <input
            value={value.lineName}
            onChange={(event) => updateTransit({ lineName: event.target.value })}
            disabled={disabled}
            placeholder="JR Keiyo Line"
            className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
          />
        </Field>
        <Field label="Number / platform">
          <div className="grid grid-cols-2 gap-2">
            <input
              value={value.serviceNumber}
              onChange={(event) => updateTransit({ serviceNumber: event.target.value })}
              disabled={disabled}
              placeholder="No."
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-3 py-3 text-sm disabled:bg-slate-100"
            />
            <input
              value={value.platform}
              onChange={(event) => updateTransit({ platform: event.target.value })}
              disabled={disabled}
              placeholder="Platform"
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-3 py-3 text-sm disabled:bg-slate-100"
            />
          </div>
        </Field>
      </div>
      <Field label="Transit notes" className="mt-3">
        <textarea
          rows={2}
          value={value.notes}
          onChange={(event) => updateTransit({ notes: event.target.value })}
          disabled={disabled}
          placeholder="Exit, transfer, luggage notes..."
          className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
        />
      </Field>
    </div>
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
  canManageTrip,
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
      className="relative z-40 isolate rounded-[1rem] border border-slate-200/70 bg-white/80 px-2.5 py-1.5 sm:px-3 sm:py-2"
    >
      <div className="mb-0.5 flex items-center justify-between gap-3 px-0.5">
        <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-slate-400">Trips</div>
        <div className="text-[9px] font-medium text-slate-400">{tripSummaries.length}</div>
      </div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || !activeTrip}
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2.5 rounded-[0.85rem] border border-slate-200/80 bg-white text-left text-slate-900 transition hover:border-slate-300 hover:bg-slate-50/70 ${
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
          <div className="overflow-hidden rounded-[1rem] border border-slate-200/90 bg-[rgba(255,253,250,0.99)] p-1.5 shadow-[0_16px_30px_rgba(15,23,42,0.075)]">
            <div className="no-scrollbar max-h-[min(24rem,56svh)] overflow-y-auto pr-0.5">
              {tripSummaries.map((trip) => {
                const selected = trip.id === activeTripId
                return (
                  <button
                    key={trip.id}
                    type="button"
                    onClick={() => handleSelectTrip(trip.id)}
                    className={`flex w-full items-center gap-3 rounded-[0.82rem] px-3 py-2.5 text-left transition ${
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
                  disabled={disabled || !activeTrip || !canManageTrip}
                  className="flex items-center justify-center gap-2 rounded-[0.78rem] px-3 py-2 text-[12px] font-semibold text-slate-600 transition hover:bg-white/80 disabled:text-slate-400"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteTrip()}
                  disabled={disabled || !activeTrip || !canManageTrip || activeTrip.id === TRIP_ID}
                  className="flex items-center justify-center gap-2 rounded-[0.78rem] px-3 py-2 text-[12px] font-semibold text-rose-600 transition hover:bg-rose-50 disabled:text-slate-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
              {canManageTrip && deletedTrips.length ? (
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
                        className="flex w-full items-center justify-between gap-3 rounded-[0.78rem] px-3 py-2 text-left text-slate-600 transition hover:bg-white/80"
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
                className="flex w-full items-center justify-between gap-3 rounded-[0.85rem] px-3 py-2.5 text-left text-slate-700 transition hover:bg-white/80 disabled:text-slate-400"
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

function AccountPanel({ canShare, user, onShare, onSignOut }) {
  return (
    <div className="rounded-[1rem] border border-slate-200/70 bg-white/78 p-2.5">
      <div className="flex items-center gap-3 px-1 py-1">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-[12px] font-semibold text-slate-700">
          {user?.photoURL ? (
            <img
              src={user.photoURL}
              alt={user.displayName || user.email || 'User'}
              className="h-full w-full object-cover"
            />
          ) : (
            (user?.displayName || user?.email || 'U').slice(0, 1).toUpperCase()
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
            {user?.displayName || 'Signed in'}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500">{user?.email || ''}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={onShare}
          disabled={!canShare}
          className="flex items-center justify-center gap-2 rounded-[0.8rem] bg-white px-3 py-2.5 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50 disabled:text-slate-400"
        >
          <Users className="h-3.5 w-3.5" />
          Share
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="flex items-center justify-center gap-2 rounded-[0.8rem] bg-white px-3 py-2.5 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </div>
  )
}

function AppDrawer({
  activeTripSummary,
  availableTrips,
  canManageCurrentTrip,
  canShare,
  currentUser,
  deletedTrips,
  disabled,
  isMobilePortrait,
  onClose,
  onCreateTrip,
  onDeleteTrip,
  onExportOverview,
  onOpenDeadlines,
  onRenameTrip,
  onRestoreTrip,
  onSelectTrip,
  onShare,
  onSignOut,
  open,
  pdfExporting,
  urgentDeadlineCount,
}) {
  return (
    <>
      <div
        onClick={open ? onClose : undefined}
        className={`fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px] transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden="true"
      />
      <aside
        className={`fixed bottom-0 left-0 top-0 z-50 flex w-[min(22rem,calc(100vw-1.4rem))] flex-col border-r border-white/70 bg-[rgba(255,253,249,0.98)] px-3.5 py-4 shadow-[18px_0_42px_rgba(15,23,42,0.11)] transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-1 pb-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Trip controls</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white p-2 text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.05)]"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2.5">
          <TripSwitcher
            activeTripId={activeTripSummary.id}
            canManageTrip={canManageCurrentTrip}
            deletedTrips={deletedTrips}
            disabled={disabled}
            isMobilePortrait={isMobilePortrait}
            onCreateTrip={onCreateTrip}
            onDeleteTrip={onDeleteTrip}
            onRenameTrip={onRenameTrip}
            onRestoreTrip={onRestoreTrip}
            onSelectTrip={onSelectTrip}
            tripSummaries={availableTrips}
          />
          {availableTrips.length ? (
            <>
              <button
                type="button"
                onClick={onExportOverview}
                disabled={pdfExporting}
                className="flex w-full items-center justify-between rounded-[0.95rem] border border-slate-200/70 bg-white/90 px-3.5 py-3 text-left text-slate-800 transition hover:bg-white disabled:cursor-wait disabled:text-slate-400"
              >
                <span>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Overview PDF
                  </span>
                  <span className="mt-1 block text-[13px] font-semibold">
                    {pdfExporting ? 'Preparing export' : 'Export and share itinerary'}
                  </span>
                </span>
                <Download className="h-4 w-4 text-slate-500" />
              </button>
              <button
                type="button"
                onClick={onOpenDeadlines}
                className="flex w-full items-center justify-between rounded-[0.95rem] border border-slate-200/70 bg-white/90 px-3.5 py-3 text-left text-slate-800 transition hover:bg-white"
              >
                <span>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Cancellation tracker
                  </span>
                  <span className="mt-1 block text-[13px] font-semibold">
                    {urgentDeadlineCount ? `${urgentDeadlineCount} urgent` : 'Monitor hotel and restaurant'}
                  </span>
                </span>
                <CalendarDays className="h-4 w-4 text-slate-500" />
              </button>
            </>
          ) : null}
        </div>

        <div className="mt-auto pt-4">
          <AccountPanel
            canShare={canShare}
            user={currentUser}
            onShare={onShare}
            onSignOut={onSignOut}
          />
        </div>
      </aside>
    </>
  )
}

function MenuButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-panel fixed left-3 top-3 z-30 flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-white sm:left-5 sm:top-5"
      aria-label="Open menu"
    >
      <Menu className="h-4 w-4" />
    </button>
  )
}

function BottomDayNav({
  activeDayId,
  dayOptions,
  dragState,
  onDayChange,
  onManageDays,
  canEdit,
  overbookingCountsByDay = {},
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 px-2 pb-[max(0.6rem,env(safe-area-inset-bottom))] sm:px-4">
      <div className="mx-auto flex max-w-5xl items-center gap-1 rounded-[1rem] border border-white/80 bg-[rgba(255,253,249,0.98)] p-1 shadow-[0_-10px_24px_rgba(15,23,42,0.075)]">
        <button
          type="button"
          onClick={() => onDayChange(DAY_VIEW_ALL)}
          className={`relative flex shrink-0 items-center whitespace-nowrap rounded-[0.8rem] px-3 py-2 text-[10px] font-bold uppercase tracking-[0.06em] transition ${
            activeDayId === DAY_VIEW_ALL ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-white'
          }`}
        >
          Overview
        </button>
        <div className="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {dayOptions.map((day, index) => {
            const overbookingCount = Number(overbookingCountsByDay[day.id] || 0)
            return (
              <button
                key={day.id}
                type="button"
                data-day-drop-id={day.id}
                onClick={() => onDayChange(day.id)}
                className={`relative shrink-0 whitespace-nowrap rounded-[0.8rem] px-2.5 py-2 text-[10px] font-bold uppercase tracking-[0.05em] transition ${
                  dragState?.overDayId === day.id
                    ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200'
                    : activeDayId === day.id
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-white'
                }`}
              >
                Day {index + 1}
                <span className={`ml-1 font-semibold normal-case tracking-normal ${activeDayId === day.id ? 'text-white/68' : 'text-slate-400'}`}>
                  {formatDayDate(day.date)}
                </span>
                {overbookingCount > 0 ? (
                  <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[9px] font-bold leading-none text-white shadow-[0_2px_8px_rgba(190,18,60,0.28)]">
                    {formatBadgeCount(overbookingCount)}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={onManageDays}
          disabled={!canEdit}
          className="shrink-0 rounded-[0.8rem] bg-white/90 px-3 py-2 text-slate-600 transition hover:bg-white disabled:text-slate-300"
          aria-label="Manage days"
        >
          <CalendarDays className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function SignInScreen({ configured, error, onSignIn }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-8 text-slate-900">
      <div className="glass-panel w-full max-w-[25.5rem] rounded-[1.25rem] px-6 py-7 text-center sm:px-7 sm:py-8">
        <div className="text-[9px] font-bold uppercase tracking-[0.28em] text-slate-400">Trip Planner</div>
        <h1 className="mt-3.5 text-[1.9rem] font-extrabold leading-tight tracking-[-0.045em] text-slate-950 sm:text-[2.08rem]">
          Sign in to your trips
        </h1>
        <p className="mx-auto mt-2.5 max-w-[20rem] text-[14px] leading-6 text-slate-600">
          Use Google sign-in to access only the trips you own or have been added to.
        </p>
        {!configured ? (
          <div className="mt-5 rounded-[0.95rem] bg-amber-50 px-4 py-3 text-left text-[13px] leading-6 text-amber-700">
            Firebase is not fully configured. Add the required Vite Firebase environment variables first.
          </div>
        ) : null}
        {error ? (
          <div className="mt-5 rounded-[0.95rem] bg-rose-50 px-4 py-3 text-left text-[13px] leading-6 text-rose-700">
            {error}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => void onSignIn()}
          disabled={!configured}
          className="mt-6 w-full rounded-[0.9rem] bg-slate-950 px-4 py-3.5 text-sm font-bold text-white shadow-[0_10px_22px_rgba(15,23,42,0.10)] transition hover:bg-slate-800 disabled:bg-slate-300"
        >
          Continue with Google
        </button>
      </div>
    </main>
  )
}

function CollaboratorsModal({
  currentRole,
  currentUser,
  isMobilePortrait,
  members,
  onAddMember,
  onClose,
  onRemoveMember,
  onUpdateRole,
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [busy, setBusy] = useState(false)
  const ownerCount = members.filter((member) => member.role === 'owner').length
  const canManage = canManageMembers(currentRole)

  async function handleAddMember() {
    if (!email.trim()) return
    setBusy(true)
    try {
      await onAddMember(email.trim(), role)
      setEmail('')
      setRole('editor')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`glass-panel w-full max-h-[82svh] overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
          isMobilePortrait ? 'rounded-[1.5rem] sm:max-w-md' : 'max-w-2xl rounded-[1.8rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Collaborators</div>
            <h3 className="mt-1 text-[1.6rem] font-bold tracking-[-0.02em] text-slate-900">Share this trip</h3>
            <p className="mt-1 text-[13px] leading-6 text-slate-600">
              Owners can add collaborators and assign editor or viewer access.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {canManage ? (
          <div className="mt-5 rounded-[1.2rem] bg-slate-50/90 p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
              <Field label="Google account email">
                <input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <Field label="Role">
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                  className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </Field>
              <button
                type="button"
                onClick={() => void handleAddMember()}
                disabled={busy || !email.trim()}
                className="rounded-[1rem] bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:bg-slate-300"
              >
                Add
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-5 space-y-2.5">
          {members.map((member) => {
            const isCurrentUser = member.uid === currentUser?.uid
            const isOnlyOwner = member.role === 'owner' && ownerCount === 1
            return (
              <div
                key={member.uid}
                className="rounded-[1.15rem] bg-white px-4 py-3.5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
                      {member.displayName || member.email || member.uid}
                    </div>
                    <div className="truncate pt-0.5 text-[11px] text-slate-500">{member.email || member.uid}</div>
                  </div>
                  {canManage ? (
                    <div className="flex items-center gap-2">
                      <select
                        value={member.role}
                        onChange={(event) => void onUpdateRole(member, event.target.value)}
                        disabled={busy || (isCurrentUser && isOnlyOwner)}
                        className="rounded-full border border-slate-200/90 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-700 disabled:bg-slate-100"
                      >
                        <option value="owner">Owner</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void onRemoveMember(member)}
                        disabled={busy || isOnlyOwner}
                        className="rounded-full bg-rose-50 p-2 text-rose-600 disabled:bg-slate-100 disabled:text-slate-300"
                        aria-label={`Remove ${member.displayName || member.email || member.uid}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-full bg-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                      {member.role}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function DayManagerModal({
  activeDayId,
  canEdit,
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
      className="fixed inset-0 z-50 flex items-end bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
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
                    disabled={!firestoreReady || !canEdit}
                    placeholder="Optional label"
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
                  />
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    value={day.date}
                    onChange={(event) => onUpdateDay(day.id, { date: event.target.value })}
                    disabled={!firestoreReady || !canEdit}
                    className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
                  />
                </Field>
                <div className="flex items-center gap-2 pb-0.5 sm:justify-end">
                  <button
                    type="button"
                    onClick={() => onMoveDay(day.id, -1)}
                    disabled={!firestoreReady || !canEdit || index === 0}
                    className="rounded-2xl bg-slate-100 p-3 text-slate-700 disabled:text-slate-300"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveDay(day.id, 1)}
                    disabled={!firestoreReady || !canEdit || index === days.length - 1}
                    className="rounded-2xl bg-slate-100 p-3 text-slate-700 disabled:text-slate-300"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteDay(day.id)}
                    disabled={!firestoreReady || !canEdit}
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
              disabled={!firestoreReady || !canEdit}
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

function NoteModal({ canEdit, item, isMobilePortrait, onClose, onDelete, onOpenDetails }) {
  const mapsUrl = item.category === 'Flight' ? '' : getGoogleMapsUrl(item)
  const locationSummary = itemLocationSummary(item)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
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
            {locationSummary ? (
              <p className="mt-1 text-[12px] leading-5 text-slate-600">{locationSummary}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {!item.generated && canEdit ? (
              <button
                type="button"
                onClick={() => void onDelete()}
                className="rounded-full bg-rose-50 p-2 text-rose-600"
                aria-label="Delete item"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            ) : null}
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
          {isMonitoredCancellationItem(item) ? (
            <div className="rounded-[1rem] bg-white px-4 py-3.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                Cancellation
              </div>
              <div className="mt-2 text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
                {itemStatusLabel(item.status)}
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                {item.cancellationDeadline
                  ? `Deadline ${formatBookingDateTime(item.cancellationDeadline)}`
                  : 'No cancellation deadline'}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-4 space-y-2">
          {canEdit ? (
            <button
              type="button"
              onClick={onOpenDetails}
              className="flex w-full items-center justify-between rounded-[0.95rem] bg-slate-900 px-4 py-3.5 text-left text-sm font-bold text-white"
            >
              <span>Edit details</span>
              <Pencil className="h-4 w-4" />
            </button>
          ) : null}
          {mapsUrl ? (
            <a
              href={mapsUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => onClose()}
              className="flex w-full items-center justify-between rounded-[0.95rem] bg-white px-4 py-3.5 text-sm font-semibold text-slate-800"
            >
              <span>Open in Google Maps</span>
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="flex w-full items-center justify-center rounded-[0.95rem] bg-slate-100 px-4 py-3.5 text-sm font-semibold text-slate-600"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function CancellationDeadlinesModal({
  canEdit,
  isMobilePortrait,
  items,
  onClose,
  onOpenDetails,
}) {
  const monitoredItems = sortedCancellationItems(items)
  const urgentCount = monitoredItems.filter((item) =>
    ['overdue', 'within_3_days'].includes(cancellationStateForItem(item)),
  ).length
  const missingDeadlineCount = monitoredItems.filter(
    (item) => cancellationStateForItem(item) === 'no_deadline',
  ).length
  const nextDeadline = monitoredItems.find((item) => item.cancellationDeadline)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`glass-panel browse-ui w-full max-h-[82svh] overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
          isMobilePortrait ? 'rounded-[1.35rem] sm:max-w-md' : 'max-w-4xl rounded-[1.65rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              Cancellation deadlines
            </div>
            <h3 className="mt-1 text-[1.45rem] font-bold tracking-[-0.025em] text-slate-900">
              Free-cancel tracker
            </h3>
            <p className="mt-1 max-w-xl text-[12px] leading-5 text-slate-600">
              Sorted by deadline. Check overdue and next 3-day cancellation windows first.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 p-2 text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-[0.95rem] bg-white px-3 py-2.5">
            <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">Urgent</div>
            <div className={`mt-1 text-[1.25rem] font-bold leading-none ${urgentCount ? 'text-rose-700' : 'text-slate-900'}`}>
              {urgentCount}
            </div>
          </div>
          <div className="rounded-[0.95rem] bg-white px-3 py-2.5">
            <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">Missing</div>
            <div className={`mt-1 text-[1.25rem] font-bold leading-none ${missingDeadlineCount ? 'text-amber-800' : 'text-slate-900'}`}>
              {missingDeadlineCount}
            </div>
          </div>
          <div className="rounded-[0.95rem] bg-white px-3 py-2.5">
            <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">Next</div>
            <div className="mt-1 truncate text-[12px] font-bold leading-5 text-slate-900">
              {nextDeadline ? formatBookingDateTime(nextDeadline.cancellationDeadline) : 'None'}
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {monitoredItems.map((item) => {
            const meta = cancellationUrgencyMeta(item)
            const name = item.locationName || item.title
            return (
              <div
                key={item.id}
                className={`relative overflow-hidden rounded-[1.05rem] border px-3.5 py-3 ${meta.card}`}
              >
                <div className={`absolute inset-y-0 left-0 w-1 ${meta.rail}`} />
                <div className={`grid gap-3 ${isMobilePortrait ? '' : 'sm:grid-cols-[minmax(0,1.35fr)_10rem_11rem_auto] sm:items-center'}`}>
                  <div className="min-w-0 pl-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-600">
                        {item.category}
                      </span>
                      <span className="text-[11px] font-medium text-slate-500">{itemStatusLabel(item.status)}</span>
                    </div>
                    <div className="mt-1.5 truncate text-[14px] font-bold tracking-[-0.015em] text-slate-950">
                      {name}
                    </div>
                  </div>

                  <div className="pl-1 sm:pl-0">
                    <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-400">Booking</div>
                    <div className="mt-1 text-[12px] font-semibold text-slate-700">
                      {formatItemBookingDateTime(item)}
                    </div>
                  </div>

                  <div className="pl-1 sm:pl-0">
                    <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-slate-400">Cancel by</div>
                    <div className={`mt-1 text-[13px] font-bold ${meta.deadline}`}>
                      {item.cancellationDeadline
                        ? formatBookingDateTime(item.cancellationDeadline)
                        : 'No deadline set'}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pl-1 sm:justify-end sm:pl-0">
                    <div>
                      <div className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${meta.badge}`}>
                        {meta.label}
                      </div>
                      <div className="mt-1 text-[10px] font-medium text-slate-500 sm:text-right">{meta.note}</div>
                    </div>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => onOpenDetails(item)}
                        className="rounded-full bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 shadow-[0_4px_12px_rgba(15,23,42,0.035)]"
                      >
                        Details
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
          {!monitoredItems.length ? (
            <div className="rounded-[1.15rem] bg-white px-4 py-7 text-center">
              <div className="text-[14px] font-bold text-slate-900">No cancellation deadlines yet</div>
              <div className="mx-auto mt-1 max-w-xs text-[12px] leading-5 text-slate-500">
                Add a hotel or restaurant item with a cancellation deadline and it will appear here.
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DetailModal({
  canEdit,
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
  const fieldReadOnly = !firestoreReady || !canEdit
  const linkedLocked = isGenerated
  const effectiveFlightCode = detailItem.flightCode || extractFlightNumber(detailItem.title || '')
  const mapsUrl = detailItem.category === 'Flight' ? '' : getGoogleMapsUrl(detailItem)
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
  const TravelModeIcon = travelModeMeta?.icon

  return (
    <div
      className="fixed inset-0 z-50 flex items-end bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
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
            {!isGenerated && canEdit ? (
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
            {TravelModeIcon ? <TravelModeIcon className="h-4 w-4 text-slate-500" /> : null}
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
                  {formatDayDate(day.date)}
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
              {categoryOptionsForValue(detailItem.category).map((option) => (
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

          {detailItem.category === 'Transport' ? (
            <TransitFields
              disabled={fieldReadOnly}
              isMobilePortrait={isMobilePortrait}
              transit={detailItem.transit}
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
          {isMonitoredCancellationItem(detailItem) ? (
            <div className={`grid gap-3.5 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
              <Field label="Status">
                <select
                  value={detailItem.status === 'active' ? 'active' : 'considering'}
                  onChange={(event) => onChange({ status: event.target.value })}
                  disabled={fieldReadOnly}
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
                >
                  <option value="considering">Considering</option>
                  <option value="active">Active</option>
                </select>
              </Field>
              <Field label="Cancellation deadline">
                <input
                  type="datetime-local"
                  value={formatDateTimeInputValue(detailItem.cancellationDeadline || '')}
                  onChange={(event) => onChange({ cancellationDeadline: event.target.value })}
                  disabled={fieldReadOnly}
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
                />
              </Field>
            </div>
          ) : null}
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

        {mapsUrl ? (
          <a
            href={mapsUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3.5 flex items-center justify-between rounded-[1rem] bg-slate-900 px-4 py-3.5 text-sm font-bold text-white"
          >
            Open in Google Maps
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : null}

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
            disabled={!firestoreReady || !canEdit}
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
  bookingOptions = [],
  canEdit,
  dayOptions,
  dayMap,
  dragState,
  filteredItems,
  firestoreReady,
  getFlightRecord,
  isMobilePortrait,
  mapsReady,
  onDragStart,
  onOpenDetails,
  onOpenNotes,
  onSaveNewItem,
  onUpdateTravelMode,
  routeSegmentMap,
  selectedWeather,
  weatherState,
}) {
  const weatherDisplay = getWeatherDisplay(activeDayId, weatherState, selectedWeather)
  const defaultDayId =
    activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)
      ? activeDayId
      : dayOptions[0]?.id || ''
  const [draft, setDraft] = useState(() => buildEmptyDraft(defaultDayId))
  const [expandedStacks, setExpandedStacks] = useState({})
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
  const timelineEntries = useMemo(
    () => buildTimelineEntries(filteredItems),
    [filteredItems],
  )
  const WeatherIcon = weatherDisplay?.icon
  const draftScheduleConflict = useMemo(() => {
    if (!effectiveDraftDayId) return null
    const existingItems = dayMap[effectiveDraftDayId]?.items || []
    return getScheduleConflictMeta([
      ...existingItems,
      { ...draft, id: draftConflictId, dayId: effectiveDraftDayId },
    ])
  }, [dayMap, draft, effectiveDraftDayId])

  useEffect(() => {
    if (!canEdit) return undefined
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
    canEdit,
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
    if (!firestoreReady || !effectiveDraftDayId || !canEdit) return

    let nextDraft = normalizeTransitForItem(stripFlightLocationFields(normalizeItemTimeFields({
      ...draft,
      dayId: effectiveDraftDayId,
    })))

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
      ...normalizeTransitForItem(stripFlightLocationFields(normalizeItemTimeFields(nextDraft))),
      dayId: effectiveDraftDayId,
      id: slugId('item'),
    })

    setDraft(buildEmptyDraft(activeDayId !== DAY_VIEW_ALL ? activeDayId : dayOptions[0]?.id || ''))
    setIsComposerOpen(false)
  }

  return (
    <>
      {weatherDisplay ? (
        <div className="sticky top-4 z-20 browse-ui">
          <div className="glass-panel flex items-center gap-3 rounded-[0.95rem] px-3 py-2.5">
            <div className="rounded-xl bg-white p-2 text-slate-700">
              {WeatherIcon ? <WeatherIcon className="h-4 w-4" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-slate-900">
                {weatherDisplay.compact || weatherDisplay.headline}
              </div>
              <div className="mt-0.5 truncate text-[10px] text-slate-500">{weatherDisplay.detail}</div>
            </div>
          </div>
        </div>
      ) : null}

      <div className={`${isMobilePortrait ? 'space-y-1.5' : 'space-y-2.5'} browse-ui`}>
        {timelineEntries.map((entry, index) => {
          const item = entry.item
          const meta = typeMeta(item.category)
          const nextSegment = routeSegmentMap[item.id]
          const isOverview = activeDayId === DAY_VIEW_ALL
          const previousItem = timelineEntries[index - 1]?.item
          const nextItem = timelineEntries[index + 1]?.item
          const showDayDivider = isOverview && (!previousItem || previousItem.dayId !== item.dayId)
          const dayContext = dayOptions.find((day) => day.id === item.dayId)
          const manualIndex = manualOrderLookup.positions[item.id]
          const isManual = !item.generated
          const locationSummary = itemLocationSummary(item)
          const transitSummary = buildTransitSummary(item)
          const isStack = entry.type === 'stack'
          const isExpandedStack = Boolean(expandedStacks[entry.id])
          const stackAlternatives = isStack ? entry.items.filter((stackItem) => stackItem.id !== item.id) : []
          const stackChoiceLabel = item.category === 'Hotel' ? 'hotel options' : 'restaurant options'
          const itemBookingOptions = bookingOptions.filter(
            (booking) => booking.linkedItemId === item.id && isHeldBookingOption(booking),
          )
          const linkedBookingMeta = item.generated
            ? { activeCount: 0, excessCount: 0, isOverbooked: false, nextDeadline: null }
            : getOverbookingMetaForItem({
                bookingOptions,
                itemId: item.id,
              })
          const stackHeldCount = isStack
            ? entry.items.filter((stackItem) => stackItem.status !== 'cancelled').length
            : 0
          const stackExcessCount = item.generated ? 0 : Math.max(0, stackHeldCount - 1)
          const excessCount = linkedBookingMeta.isOverbooked
            ? linkedBookingMeta.excessCount
            : stackExcessCount
          const isOverbooked = excessCount > 0
          const comparisonCount = linkedBookingMeta.isOverbooked
            ? linkedBookingMeta.activeCount
            : entry.items.length
          const comparisonAltCount = Math.max(0, comparisonCount - 1)
          const nextCancelDeadline =
            linkedBookingMeta.nextDeadline?.cancellationDeadline ||
            [...entry.items]
              .filter((candidate) => candidate.cancellationDeadline)
              .sort(
                (a, b) =>
                  new Date(a.cancellationDeadline).getTime() - new Date(b.cancellationDeadline).getTime(),
              )[0]?.cancellationDeadline ||
            ''
          const showOptionsRow = isStack || linkedBookingMeta.isOverbooked
          const toggleStack = (event) => {
            event?.stopPropagation?.()
            setExpandedStacks((current) => ({
              ...current,
              [entry.id]: !current[entry.id],
            }))
          }
          const showBeforeSlot = Boolean(dragState && isManual)
          const showAfterSlot =
            Boolean(dragState && isManual) &&
            (!nextItem || nextItem.dayId !== item.dayId || nextItem.generated)
          const isDraggingItem = dragState?.itemId === item.id
          return (
            <div key={entry.id} className={isMobilePortrait ? 'space-y-1.5' : 'space-y-2'}>
              {showDayDivider ? (
                <div className={`flex items-center gap-3 px-1 first:pt-0 ${isMobilePortrait ? 'py-2.5' : 'py-4'}`}>
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
                className={`timeline-card ${meta.card} relative rounded-[1.08rem] px-3 py-3 transition hover:bg-white active:bg-white sm:px-5 sm:py-4 ${
                  isDraggingItem ? 'scale-[0.995] opacity-45 ring-2 ring-slate-300/70' : ''
                }`}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onOpenNotes(item)
                  }
                }}
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={(event) => onOpenDetails.startPress(event, item)}
                onPointerMove={onOpenDetails.movePress}
                onPointerUp={(event) => onOpenDetails.endPress(event, item, isStack ? toggleStack : undefined)}
                onPointerCancel={onOpenDetails.cancelPress}
                onPointerLeave={onOpenDetails.cancelPress}
              >
                <div className="flex gap-3 sm:gap-5">
                  <div className="w-[3.1rem] shrink-0 pt-0.5 text-right sm:w-[3.55rem]">
                    <div className="text-[13px] font-bold tracking-[-0.01em] text-slate-900">{item.startTime}</div>
                    {item.endTime ? <div className="mt-0.5 text-[10px] font-medium tracking-[-0.01em] text-slate-400 sm:mt-1">{item.endTime}</div> : null}
                  </div>
                  <div className="timeline-rail shrink-0">
                    <span className={`timeline-dot ${meta.tone}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`flex ${isMobilePortrait ? 'flex-col items-stretch gap-2' : 'items-start justify-between gap-3'}`}>
                      <div className="min-w-0">
                        <h3 className={`${isMobilePortrait ? 'line-clamp-2 leading-5' : 'leading-6'} text-[0.98rem] font-bold tracking-[-0.02em] text-slate-950`}>{item.title}</h3>
                        {locationSummary ? (
                          <p className="mt-0.5 truncate text-[12px] text-slate-500 sm:mt-1">{locationSummary}</p>
                        ) : null}
                      </div>
                      <div className={`flex items-center gap-2 ${isMobilePortrait ? 'justify-between' : ''}`}>
                        {item.generated ? (
                          <div className="rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700">
                            Linked
                          </div>
                        ) : canEdit ? (
                          <button
                            type="button"
                            onPointerDown={(event) => onDragStart(event, item)}
                            onClick={(event) => event.stopPropagation()}
                            data-drag-handle="true"
                            className={`touch-none rounded-full bg-slate-50 p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 active:scale-95 sm:p-2 ${isMobilePortrait ? 'ml-auto' : ''}`}
                            aria-label={`Drag ${item.title}`}
                          >
                            <GripVertical className="h-4 w-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {item.address && item.address !== item.locationName ? (
                      <p className="mt-0.5 truncate text-[11px] text-slate-400 sm:mt-1">{item.address}</p>
                    ) : null}
                    {transitSummary ? (
                      <div className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
                        <TrainFront className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{transitSummary}</span>
                      </div>
                    ) : null}
                    {(item.description || item.generated) ? (
                      <p className="mt-1.5 line-clamp-2 text-[12px] leading-5 text-slate-500 sm:mt-2 sm:leading-6">
                        {item.generated ? 'Auto-carried from the previous day hotel stay.' : item.description}
                      </p>
                    ) : null}
                    {showOptionsRow ? (
                      <button
                        type="button"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={toggleStack}
                        aria-expanded={isExpandedStack}
                        className="mt-2 flex w-full items-center justify-between gap-3 rounded-[0.85rem] border border-slate-200/75 bg-slate-50/85 px-3 py-2 text-left transition hover:border-slate-300 hover:bg-white sm:mt-3 sm:py-2.5"
                      >
                        <span className="min-w-0">
                          <span className="block text-[12px] font-bold tracking-[-0.01em] text-slate-800">
                            {isExpandedStack
                              ? `Hide ${comparisonAltCount} other ${comparisonAltCount === 1 ? 'option' : 'options'}`
                              : `Compare ${comparisonAltCount} other ${comparisonAltCount === 1 ? 'option' : 'options'}`}
                          </span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
                            {comparisonCount} overlapping {stackChoiceLabel}
                          </span>
                          {nextCancelDeadline ? (
                            <span className="mt-1 block text-[11px] font-semibold leading-4 text-slate-600">
                              Next cancel deadline: {formatBookingDateTime(nextCancelDeadline)}
                            </span>
                          ) : null}
                          {isOverbooked ? (
                            <span className="mt-1.5 inline-flex rounded-full bg-rose-50 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-rose-700">
                              Overbooked · {excessCount} {excessCount === 1 ? 'extra' : 'extras'} to cancel
                            </span>
                          ) : null}
                        </span>
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-slate-500">
                          <ChevronDown className={`h-4 w-4 transition ${isExpandedStack ? 'rotate-180' : ''}`} />
                        </span>
                      </button>
                    ) : null}
                    {isMonitoredCancellationItem(item) && item.cancellationDeadline ? (
                      <div className="mt-2 rounded-[0.8rem] bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600 sm:mt-3">
                        <span className="font-semibold text-slate-800">{itemStatusLabel(item.status)}</span>
                        <span className="block">
                          Cancellation deadline: {formatBookingDateTime(item.cancellationDeadline)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </article>

              {isExpandedStack && isStack ? (
                <div className="ml-[4.45rem] space-y-1.5 overflow-visible sm:ml-[5.9rem] sm:space-y-2.5">
                  {stackAlternatives.map((stackItem, stackIndex) => {
                    const stackMeta = typeMeta(stackItem.category)
                    const stackHasActive = hasActiveStayOrMealStatus(stackItem)
                    return (
                      <article
                        key={stackItem.id}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                          }
                        }}
                        onContextMenu={(event) => event.preventDefault()}
                        onPointerDown={(event) => onOpenDetails.startPress(event, stackItem)}
                        onPointerMove={onOpenDetails.movePress}
                        onPointerUp={(event) => onOpenDetails.endPress(event, stackItem)}
                        onPointerCancel={onOpenDetails.cancelPress}
                        onPointerLeave={onOpenDetails.cancelPress}
                        className={`rounded-[0.95rem] border border-slate-200/70 bg-white/86 px-3 py-2.5 shadow-[0_10px_22px_rgba(15,23,42,0.035)] transition hover:bg-white sm:px-3.5 sm:py-3 ${
                          isMobilePortrait ? 'border-l-4' : ''
                        }`}
                        style={
                          isMobilePortrait
                            ? {
                                borderLeftColor: stackHasActive ? '#10b981' : '#cbd5e1',
                              }
                            : {
                                transform: `translateX(${Math.min((stackIndex + 1) * 10, 28)}px) rotate(${Math.min((stackIndex + 1) * 0.35, 1)}deg)`,
                                width: `calc(100% - ${Math.min((stackIndex + 1) * 10, 28)}px)`,
                              }
                        }
                      >
                        <div className="flex items-start gap-3">
                          <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${stackMeta.tone}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
                                  {stackItem.title}
                                </div>
                                <div className="mt-1 text-[11px] leading-5 text-slate-500">
                                  {stackItem.startTime}
                                  {stackItem.endTime ? `-${stackItem.endTime}` : ''}
                                  {stackItem.locationName ? ` · ${stackItem.locationName}` : ''}
                                </div>
                              </div>
                              {stackHasActive ? (
                                <div className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-emerald-700">
                                  Active
                                </div>
                              ) : null}
                            </div>
                            {stackItem.cancellationDeadline ? (
                              <div className="mt-2 text-[11px] text-slate-500">
                                Deadline {formatBookingDateTime(stackItem.cancellationDeadline)}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : isExpandedStack && linkedBookingMeta.isOverbooked ? (
                <div className="ml-[4.45rem] space-y-1.5 overflow-visible sm:ml-[5.9rem] sm:space-y-2">
                  {itemBookingOptions.map((booking) => {
                    const bookingDeadline = booking.cancellationDeadline
                      ? formatBookingDateTime(booking.cancellationDeadline)
                      : 'No deadline set'
                    return (
                      <article
                        key={booking.id}
                        className="rounded-[0.95rem] border border-slate-200/70 bg-white/90 px-3 py-2.5 shadow-[0_8px_16px_rgba(15,23,42,0.025)]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900">
                              {booking.title || item.locationName || item.title}
                            </div>
                            <div className="mt-1 text-[11px] leading-5 text-slate-500">
                              {booking.provider ? `${booking.provider} · ` : ''}
                              {booking.bookingRef || 'No booking ref'}
                            </div>
                            <div className="mt-1 text-[11px] font-semibold text-slate-600">
                              Cancel by {bookingDeadline}
                            </div>
                          </div>
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600">
                            {booking.status}
                          </span>
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : null}

              {nextSegment ? (
                <div
                  className={`ml-[4.45rem] rounded-[0.9rem] px-3 py-1 text-[11px] text-slate-500 sm:ml-[5.9rem] sm:px-4 sm:py-1.5 ${
                    isMobilePortrait
                      ? 'flex items-center justify-between gap-3'
                      : 'flex items-center justify-between gap-4'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
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
                  {canEdit ? (
                    <RouteModeControl
                      currentMode={nextSegment.from.travelModeToNext || ''}
                      onSelect={(mode) => onUpdateTravelMode(nextSegment.from.id, mode)}
                    />
                  ) : null}
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

      <div className="glass-panel rounded-[1.08rem] px-3 py-3 sm:px-5 sm:py-4 browse-ui">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="headline text-[1.18rem] leading-none text-slate-950 sm:text-[1.35rem]">Add stop</h3>
            <p className="mt-1 hidden text-[13px] text-slate-500 sm:block">Open the composer only when you need it.</p>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setIsComposerOpen((open) => !open)}
              className={`rounded-[0.85rem] px-4 py-2.5 text-[13px] font-bold transition ${
                isComposerOpen ? 'bg-slate-900 text-white' : 'bg-white text-slate-700'
              }`}
            >
              {isComposerOpen ? 'Hide form' : 'New stop'}
            </button>
          ) : null}
        </div>

        {isComposerOpen && canEdit ? (
          <>
            <div className={`mt-3.5 grid gap-3 ${isMobilePortrait ? '' : 'sm:grid-cols-2 sm:gap-3.5 sm:mt-5'}`}>
              <Field label="Day">
                <select
                  value={effectiveDraftDayId}
                  onChange={(event) => setDraft((current) => ({ ...current, dayId: event.target.value }))}
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                >
                  {dayOptions.map((day) => (
                    <option key={day.id} value={day.id}>
                      {formatDayDate(day.date)}
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
                          transit: null,
                        }
                      }

                      return {
                        ...current,
                        category: nextCategory,
                        transit: nextCategory === 'Transport' ? normalizeTransitDetails(current.transit) : null,
                        startTime: current.startTime || '10:00',
                        endTime: current.endTime || '11:00',
                        endTimeMode: current.endTimeMode || 'time',
                        status: isMonitoredCancellationItem({ category: nextCategory })
                          ? current.status || 'considering'
                          : '',
                        cancellationDeadline: isMonitoredCancellationItem({ category: nextCategory })
                          ? current.cancellationDeadline || ''
                          : '',
                      }
                    })
                  }
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                >
                  {categoryOptionsForValue(draft.category).map((option) => (
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

            <div className="mt-3 space-y-3 sm:mt-4">
              {draft.category !== 'Flight' ? (
                <PlaceFields
                  draft={draft}
                  disabled={!firestoreReady}
                  mapsReady={mapsReady}
                  onChange={(changes) => setDraft((current) => ({ ...current, ...changes }))}
                />
              ) : null}

              {draft.category === 'Transport' ? (
                <TransitFields
                  disabled={!firestoreReady}
                  isMobilePortrait={isMobilePortrait}
                  transit={draft.transit}
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
              {isMonitoredCancellationItem(draft) ? (
                <div className={`grid gap-3.5 ${isMobilePortrait ? '' : 'sm:grid-cols-2'}`}>
                  <Field label="Status">
                    <select
                      value={draft.status === 'active' ? 'active' : 'considering'}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, status: event.target.value }))
                      }
                      className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                    >
                      <option value="considering">Considering</option>
                      <option value="active">Active</option>
                    </select>
                  </Field>
                  <Field label="Cancellation deadline">
                    <input
                      type="datetime-local"
                      value={formatDateTimeInputValue(draft.cancellationDeadline || '')}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, cancellationDeadline: event.target.value }))
                      }
                      className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                    />
                  </Field>
                </div>
              ) : null}
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
              <div className="mt-3 hidden rounded-[0.95rem] bg-white px-4 py-3 text-[13px] leading-6 text-slate-500 sm:block">
            {canEdit
              ? 'Open the composer only when you need to add a new stop.'
              : 'You have view-only access on this trip.'}
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
      <div className="glass-panel rounded-[1.08rem] px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="headline text-[1.35rem] leading-none text-slate-950">Map</h2>
            <p className="mt-1 text-[13px] text-slate-500">
              {activeDayId === DAY_VIEW_ALL ? 'Whole trip view' : 'Selected day route'}
            </p>
          </div>
        </div>

        <div
          className={`mt-4 overflow-hidden rounded-[0.95rem] border border-slate-200/80 bg-slate-100 ${
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
  const [currentUser, setCurrentUser] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [authError, setAuthError] = useState('')
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
  const [showCollaborators, setShowCollaborators] = useState(false)
  const [showDeadlines, setShowDeadlines] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [pdfExporting, setPdfExporting] = useState(false)
  const [dragState, setDragState] = useState(null)
  const [tripMembers, setTripMembers] = useState([])

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
  const availableTrips = useMemo(
    () =>
      tripSummaries
        .filter((trip) => !trip.hidden && canViewTrip(trip.role))
        .sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [tripSummaries],
  )
  const resolvedTripId = availableTrips.some((trip) => trip.id === activeTripId)
    ? activeTripId
    : availableTrips[0]?.id || ''

  const tripState = useMemo(() => deriveTripState(overrides), [overrides])
  const activeTripSummary =
    availableTrips.find((trip) => trip.id === resolvedTripId) || defaultTripSummary
  const activeRole = activeTripSummary?.role || ''
  const canEditCurrentTrip = canEditTrip(activeRole)
  const canManageCurrentTrip = canManageMembers(activeRole)
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
  const overbookingCountsByDay = useMemo(
    () =>
      getOverbookingCountsByDay({
        bookingOptions: tripState.bookingOptions,
        items: tripState.items,
      }),
    [tripState.bookingOptions, tripState.items],
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
  const firestoreReady = firebaseEnabled && authReady && Boolean(currentUser) && firestoreState.status === 'ready'
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
  const urgentDeadlineCount = useMemo(
    () =>
      tripState.items.filter((item) =>
        ['overdue', 'within_3_days'].includes(cancellationStateForItem(item)),
      ).length,
    [tripState.items],
  )

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
    if (resolvedTripId) {
      window.localStorage.setItem(ACTIVE_TRIP_STORAGE_KEY, resolvedTripId)
    }
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

    if (!firebaseEnabled) {
      queueMicrotask(() => {
        if (!active) return
        setAuthReady(true)
        setFirestoreState({ status: 'disabled', error: 'Firebase env vars missing' })
      })
      return () => {
        active = false
      }
    }

    let unsubscribe = () => {}

    async function connectAuth() {
      unsubscribe = await subscribeToAuthState(
        async (user) => {
          if (!active) return
          setCurrentUser(user || null)
          setAuthError('')
          setAuthReady(true)

          if (user) {
            try {
              await ensureUserProfile(user)
            } catch (error) {
              console.error(error)
            }
          } else {
            setTripSummaries([])
            setOverrides({ days: {}, items: {} })
            setFirestoreState({ status: 'connecting', error: '' })
          }
        },
        (error) => {
          console.error(error)
          if (active) {
            setAuthReady(true)
            setAuthError(error?.message || 'Authentication failed')
            setCurrentUser(null)
          }
        },
      )
    }

    void connectAuth()
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!authReady || !firebaseEnabled || !currentUser?.uid) return undefined

    let active = true
    let unsubscribe = () => {}

    async function connectDirectory() {
      unsubscribe = await subscribeToUserTripDirectory(
        currentUser.uid,
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
  }, [authReady, currentUser?.uid])

  useEffect(() => {
    if (!authReady || !firebaseEnabled || !currentUser?.uid || !resolvedTripId) return undefined

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
  }, [authReady, currentUser?.uid, resolvedTripId])

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
    if (!canEditCurrentTrip) return undefined
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
    canEditCurrentTrip,
    detailDayDate,
    detailFlightCode,
    detailFlightLookupKey,
    detailAppliedLookupKey,
    detailCategory,
    detailItemId,
    getFlightRecord,
    tripState.dayMap,
  ])

  useEffect(() => {
    if (!firebaseEnabled || !authReady || !resolvedTripId || !canViewTrip(activeRole)) {
      queueMicrotask(() => setTripMembers([]))
      return undefined
    }

    let active = true
    let unsubscribe = () => {}

    async function connectMembers() {
      unsubscribe = await subscribeToTripMembers(
        resolvedTripId,
        (payload) => {
          if (!active) return
          setTripMembers(payload || [])
        },
        (error) => {
          console.error(error)
        },
      )
    }

    void connectMembers()
    return () => {
      active = false
      unsubscribe()
    }
  }, [activeRole, authReady, resolvedTripId])

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
  const routeSegmentMap = useMemo(
    () => Object.fromEntries(routeSegments.map((segment) => [segment.from.id, segment])),
    [routeSegments],
  )

  async function handleSignIn() {
    try {
      setAuthError('')
      await signInWithGoogle()
    } catch (error) {
      console.error(error)
      setAuthError(error?.message || 'Google sign-in failed')
    }
  }

  async function handleSignOut() {
    try {
      await signOutUser()
      setShowCollaborators(false)
      setNoteItem(null)
      setDetailItem(null)
      setTripMembers([])
    } catch (error) {
      console.error(error)
      setAuthError(error?.message || 'Sign out failed')
    }
  }

  async function saveItem(item) {
    if (!canEditCurrentTrip) return
    const normalizedItem = stripFlightLocationFields(normalizeItemTimeFields(item))
    const sameDayItems = (tripState.dayMap[item.dayId]?.items || []).filter((existing) => existing.id !== item.id)
    const manualItems = sameDayItems.filter((existing) => !existing.generated)
    const patchItems = Object.fromEntries(
      mergeItemsForDay(manualItems, normalizedItem).map((entry) => [entry.id, entry]),
    )
    await mergeTripPatch(resolvedTripId, { items: patchItems })
  }

  async function createTrip() {
    if (!firebaseEnabled || !authReady || !currentUser?.uid) return

    const nextIndex = availableTrips.length + 1
    const suggestedTitle = `Trip ${nextIndex}`
    const title = window.prompt('Trip name', suggestedTitle)?.trim()
    if (!title) return

    const tripId = slugId('trip')
    const snapshot = buildBlankTripSnapshot()
    const nextSummary = {
      id: tripId,
      title,
      role: 'owner',
      hidden: false,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
    }

    try {
      await createTripRecordWithOwner(
        tripId,
        {
          title: nextSummary.title,
          startDate: nextSummary.startDate,
          endDate: nextSummary.endDate,
          days: snapshot.days,
          items: snapshot.items,
          bookingOptions: snapshot.bookingOptions,
        },
        currentUser,
      )

      setTripSummaries((current) =>
        current.some((trip) => trip.id === tripId) ? current : [...current, nextSummary],
      )
      selectTrip(tripId)
      setFirestoreState((current) => ({ ...current, error: '' }))
    } catch (error) {
      console.error(error)
      const message = error?.message || 'Trip creation failed'
      setFirestoreState((current) => ({ ...current, status: 'error', error: message }))
      window.alert(message)
    }
  }

  async function renameTrip() {
    if (!firestoreReady || !canManageCurrentTrip) return

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
    if (!firestoreReady || !canManageCurrentTrip) return
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
    if (!firestoreReady || !tripId || !canManageCurrentTrip) return
    await upsertTripMeta(tripId, { hidden: false })
    selectTrip(tripId)
  }

  async function updateDay(dayId, changes) {
    if (!canEditCurrentTrip) return
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
    if (!firestoreReady || !canEditCurrentTrip || !draft.date) return
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
    if (!canEditCurrentTrip) return
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
    if (!canEditCurrentTrip) return
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
      bookingOptions: Object.fromEntries(
        tripState.bookingOptions
          .filter((booking) => booking.dayId === dayId)
          .map((booking) => [booking.id, { hidden: true }]),
      ),
    })
    setActiveDayId(remaining[0]?.id || DAY_VIEW_ALL)
  }

  async function deleteItem(itemId) {
    if (!canEditCurrentTrip) return
    await mergeTripPatch(resolvedTripId, {
      items: { [itemId]: { hidden: true } },
      bookingOptions: Object.fromEntries(
        tripState.bookingOptions
          .filter((booking) => booking.linkedItemId === itemId)
          .map((booking) => [booking.id, { hidden: true }]),
      ),
    })
    setNoteItem((current) => (current?.id === itemId ? null : current))
    setDetailItem((current) => (current?.id === itemId ? null : current))
  }

  async function updateTravelMode(itemId, travelModeToNext) {
    if (!canEditCurrentTrip) return
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
    if (!canEditCurrentTrip) return
    setNoteItem(null)
    setDetailItem(createItemDraft(item))
  }

  function updateDetail(changes) {
    setDetailItem((current) => (current ? applyItemDraftPatch(current, changes) : current))
  }

  async function saveDetailItem() {
    if (!detailItem || !firestoreReady || !canEditCurrentTrip) return

    const nextItem = normalizeTransitForItem(normalizeItemTimeFields(detailItem))

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

  async function addCollaborator(email, role) {
    if (!canManageCurrentTrip || !currentUser?.uid) return

    const match = await lookupUserByEmail(email)
    if (!match) {
      window.alert('This person needs to sign in once before they can be added.')
      return
    }
    if (match.uid === currentUser.uid) {
      window.alert('You already have access to this trip.')
      return
    }
    if (tripMembers.some((member) => member.uid === match.uid)) {
      window.alert('This person is already a collaborator on the trip.')
      return
    }

    await addTripMember(
      resolvedTripId,
      currentUser,
      match,
      role,
      {
        title: activeTripSummary.title,
        startDate: activeTripSummary.startDate,
        endDate: activeTripSummary.endDate,
        hidden: false,
      },
    )
  }

  async function changeCollaboratorRole(member, role) {
    if (!canManageCurrentTrip) return

    const ownerCount = tripMembers.filter((entry) => entry.role === 'owner').length
    if (member.uid === currentUser?.uid && member.role === 'owner' && role !== 'owner' && ownerCount === 1) {
      window.alert('You cannot demote yourself as the only owner.')
      return
    }

    await updateTripMemberRole(
      resolvedTripId,
      member.uid,
      role,
      {
        title: activeTripSummary.title,
        startDate: activeTripSummary.startDate,
        endDate: activeTripSummary.endDate,
        hidden: false,
      },
    )
  }

  async function removeCollaborator(member) {
    if (!canManageCurrentTrip) return

    const ownerCount = tripMembers.filter((entry) => entry.role === 'owner').length
    if (member.role === 'owner' && ownerCount === 1) {
      window.alert('You cannot remove the last owner.')
      return
    }

    if (!window.confirm(`Remove ${member.displayName || member.email || member.uid} from this trip?`)) return
    await removeTripMember(resolvedTripId, member.uid)
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
          setNoteItem(item)
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

  function endPress(event, item, onTap) {
    const state = pressStateRef.current
    if (state.pointerId !== event.pointerId) return
    const shouldHandleTap = !state.moved && !state.longPressed && state.itemId === item.id
    clearPressState()
    if (shouldHandleTap) onTap?.()
  }

  const handleExportOverviewPdf = async () => {
    if (pdfExporting) return
    setPdfExporting(true)
    try {
      await shareTripOverviewPdf({
        days: visibleDays,
        items: tripState.items,
        tripSummary: activeTripSummary,
      })
      setShowMenu(false)
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('PDF export failed', error)
        window.alert('Could not export the overview PDF. Please try again.')
      }
    } finally {
      setPdfExporting(false)
    }
  }

  if (authReady && !currentUser) {
    return <SignInScreen configured={firebaseEnabled} error={authError} onSignIn={handleSignIn} />
  }

  if (!authReady) {
    return (
      <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-10 text-slate-600">
        <div className="glass-panel rounded-[1.25rem] border border-white/60 px-5 py-4 text-sm font-medium">
          Loading trip access...
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl overflow-x-clip px-2.5 py-3 pb-20 pt-11 text-slate-900 sm:px-6 sm:py-5 sm:pb-24 sm:pt-16 lg:px-8">
      <MenuButton onClick={() => setShowMenu(true)} />
      <AppDrawer
        activeTripSummary={activeTripSummary}
        availableTrips={availableTrips}
        canManageCurrentTrip={canManageCurrentTrip}
        canShare={canViewTrip(activeRole)}
        currentUser={currentUser}
        deletedTrips={deletedTrips}
        disabled={!currentUser?.uid}
        isMobilePortrait={isMobilePortrait}
        onClose={() => setShowMenu(false)}
        onCreateTrip={() => void createTrip()}
        onDeleteTrip={() => void deleteTrip()}
        onExportOverview={() => void handleExportOverviewPdf()}
        onOpenDeadlines={() => {
          setShowMenu(false)
          setShowDeadlines(true)
        }}
        onRenameTrip={() => void renameTrip()}
        onRestoreTrip={(tripId) => void restoreTrip(tripId)}
        onSelectTrip={(tripId) => {
          selectTrip(tripId)
          setShowMenu(false)
        }}
        onShare={() => {
          setShowMenu(false)
          setShowCollaborators(true)
        }}
        onSignOut={() => {
          setShowMenu(false)
          void handleSignOut()
        }}
        open={showMenu}
        pdfExporting={pdfExporting}
        urgentDeadlineCount={urgentDeadlineCount}
      />
      {!availableTrips.length ? (
        <div className="glass-panel max-w-md rounded-[1.08rem] px-5 py-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Trips</div>
          <h2 className="mt-2 text-[1.35rem] font-extrabold tracking-[-0.03em] text-slate-950">No trips yet</h2>
          <p className="mt-2 text-[13px] leading-6 text-slate-600">
            Create your first trip, or ask the trip owner to add you as a collaborator.
          </p>
          <button
            type="button"
            onClick={() => void createTrip()}
            disabled={!firebaseEnabled || !authReady || !currentUser?.uid}
            className="mt-4 rounded-[0.9rem] bg-slate-950 px-4 py-3 text-sm font-bold text-white shadow-[0_10px_22px_rgba(15,23,42,0.10)] transition hover:bg-slate-800 disabled:bg-slate-300"
          >
            Create trip
          </button>
        </div>
      ) : null}
      {availableTrips.length ? (
      <section
        className={
          isMobilePortrait
            ? 'mx-auto max-w-[28rem] space-y-2.5'
            : 'grid gap-6 lg:grid-cols-[1.08fr_0.92fr]'
        }
      >
        <div className={isMobilePortrait ? 'space-y-2.5' : 'space-y-4'}>
          <PlannerPanel
            activeDayId={resolvedActiveDayId}
            bookingOptions={tripState.bookingOptions}
            canEdit={canEditCurrentTrip}
            dayOptions={dayOptions}
            dayMap={tripState.dayMap}
            dragState={dragState}
            filteredItems={filteredItems}
            firestoreReady={firestoreReady}
            getFlightRecord={getFlightRecord}
            isMobilePortrait={isMobilePortrait}
            mapsReady={googleMapsState.ready}
            onDragStart={beginItemDrag}
            onOpenDetails={{
              startPress,
              movePress,
              endPress,
              cancelPress: clearPressState,
            }}
            onOpenNotes={openNotes}
            onSaveNewItem={saveItem}
            onUpdateTravelMode={(itemId, mode) => void updateTravelMode(itemId, mode)}
            routeSegmentMap={routeSegmentMap}
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
      ) : null}

      {availableTrips.length ? (
        <BottomDayNav
          activeDayId={resolvedActiveDayId}
          canEdit={canEditCurrentTrip}
          dayOptions={dayOptions}
          dragState={dragState}
          overbookingCountsByDay={overbookingCountsByDay}
          onDayChange={(dayId) => {
            startTransition(() => {
              setActiveDayId(dayId)
            })
          }}
          onManageDays={() => setShowDayManager(true)}
        />
      ) : null}

      {showDayManager ? (
        <DayManagerModal
          activeDayId={resolvedActiveDayId}
          canEdit={canEditCurrentTrip}
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
          canEdit={canEditCurrentTrip}
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

      {showDeadlines ? (
        <CancellationDeadlinesModal
          canEdit={canEditCurrentTrip}
          isMobilePortrait={isMobilePortrait}
          items={tripState.items}
          onClose={() => setShowDeadlines(false)}
          onOpenDetails={(item) => {
            setShowDeadlines(false)
            openDetails(item)
          }}
        />
      ) : null}

      {detailItem ? (
        <DetailModal
          canEdit={canEditCurrentTrip}
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

      {showCollaborators && canViewTrip(activeRole) ? (
        <CollaboratorsModal
          currentRole={activeRole}
          currentUser={currentUser}
          isMobilePortrait={isMobilePortrait}
          members={tripMembers}
          onAddMember={(email, role) => addCollaborator(email, role)}
          onClose={() => setShowCollaborators(false)}
          onRemoveMember={(member) => removeCollaborator(member)}
          onUpdateRole={(member, role) => changeCollaboratorRole(member, role)}
        />
      ) : null}
    </main>
  )
}
