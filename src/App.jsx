import React, {
  Suspense,
  lazy,
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  AlertTriangle,
  BedDouble,
  CalendarDays,
  Check,
  ChevronDown,
  CircleEllipsis,
  Cloud,
  CloudRain,
  Copy,
  Download,
  Landmark,
  LogOut,
  Pencil,
  Footprints,
  ExternalLink,
  Loader2,
  Menu,
  PackageOpen,
  Plane,
  Plus,
  Search,
  Share2,
  Shuffle,
  Star,
  Sun,
  Trash2,
  Utensils,
  Users,
  X,
  ArrowUpDown,
  CarFront,
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
  acceptTripInvite,
  createTripRecordWithOwner,
  createTripInvite,
  deleteTripRecord,
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
  PARKING_LOT_DATE,
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
  sortItemsByTimeline,
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
const SUBSTITUTE_STACK_OFFSETS = [
  { y: 0, opacity: 1 },
  { y: 0, opacity: 0.98 },
  { y: 0, opacity: 0.94 },
  { y: 0, opacity: 0.9 },
]
const SUBSTITUTE_STACK_VISIBLE_DEPTH = 4
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
const GUEST_USER = {
  uid: '',
  displayName: 'Offline mode',
  email: '',
  photoURL: '',
}
const LOCAL_TRIP_OVERRIDES_KEY = 'trip-planner-temporary-overrides'

function canViewTrip(role) {
  return ['owner', 'admin', 'editor', 'viewer'].includes(role)
}

function canEditTrip(role) {
  return ['owner', 'admin', 'editor'].includes(role)
}

function canDeleteTrip(role, tripSummary = null, user = null) {
  return (
    role === 'owner' &&
    (Boolean(user?.uid && [tripSummary?.ownerId, tripSummary?.createdBy].includes(user.uid)) ||
      Boolean(tripSummary?.isDemo))
  )
}

function canManageMembers(role, tripSummary = null, user = null) {
  return (
    ['owner', 'admin'].includes(role) ||
    Boolean(user?.uid && [tripSummary?.ownerId, tripSummary?.createdBy].includes(user.uid))
  )
}

function roleLabel(role) {
  if (role === 'viewer') return 'Read-only'
  if (role === 'owner') return 'Owner'
  if (role === 'admin') return 'Admin'
  if (role === 'editor') return 'Editor'
  return role || 'Unknown'
}

function normalizeTripCity(city) {
  return String(city || '').replace(/\s+/g, ' ').trim()
}

function roleAccessDescription(role) {
  if (role === 'admin') return 'Admin: full control of trip details and collaborators.'
  if (role === 'editor') return 'Editor: add/update trip details, cannot manage collaborators.'
  if (role === 'viewer') return 'Read-only: can view the trip without making changes.'
  return 'Choose what this person can view or edit.'
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
      const handleError = () => setError('Map preview is temporarily unavailable.')
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
    script.addEventListener('error', () => setError('Map preview is temporarily unavailable.'))
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
  if (category === 'Others') return { tone: 'bg-slate-100 text-slate-600', card: 'timeline-card--other' }
  return { tone: 'bg-emerald-50 text-emerald-600', card: 'timeline-card--activity' }
}

function categoryOptionsForValue() {
  return CATEGORY_OPTIONS
}

const CATEGORY_ICON_COMPONENTS = {
  Car: CarFront,
  Activity: Landmark,
  Restaurant: Utensils,
  Transport: TrainFront,
  Flight: Plane,
  Hotel: BedDouble,
  Others: CircleEllipsis,
}

function CategoryControl({ disabled = false, label = 'Category', onChange, value }) {
  const scrollerRef = useRef(null)
  const [scrollHints, setScrollHints] = useState({ left: false, right: false })

  const updateScrollHints = useCallback(() => {
    const node = scrollerRef.current
    if (!node) return
    const maxScrollLeft = node.scrollWidth - node.clientWidth
    setScrollHints({
      left: node.scrollLeft > 4,
      right: node.scrollLeft < maxScrollLeft - 4,
    })
  }, [])

  useEffect(() => {
    updateScrollHints()
    const node = scrollerRef.current
    if (!node) return undefined

    node.addEventListener('scroll', updateScrollHints, { passive: true })
    window.addEventListener('resize', updateScrollHints)
    return () => {
      node.removeEventListener('scroll', updateScrollHints)
      window.removeEventListener('resize', updateScrollHints)
    }
  }, [updateScrollHints])

  return (
    <div className="block min-w-0">
      <div className="mb-2 block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {label}
      </div>
      <div className="relative">
        {scrollHints.left ? (
          <div className="pointer-events-none absolute left-1 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200/80 bg-white/95 text-slate-600 shadow-[0_8px_18px_rgba(15,23,42,0.12)]">
            <ChevronDown className="h-4 w-4 rotate-90" />
          </div>
        ) : null}
        {scrollHints.right ? (
          <div className="pointer-events-none absolute right-1 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200/80 bg-white/95 text-slate-600 shadow-[0_8px_18px_rgba(15,23,42,0.12)]">
            <ChevronDown className="h-4 w-4 -rotate-90" />
          </div>
        ) : null}
        <div
          ref={scrollerRef}
          role="radiogroup"
          aria-label={label}
          className="no-scrollbar flex w-full max-w-full items-center gap-1 overflow-x-auto rounded-[1.15rem] border border-slate-200/90 bg-white p-1"
        >
          {categoryOptionsForValue(value).map((option) => {
            const Icon = CATEGORY_ICON_COMPONENTS[option] || CircleEllipsis
            const active = option === value
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={option}
                title={option}
                disabled={disabled}
                onClick={() => onChange(option)}
                className={`flex min-h-[3.15rem] min-w-[4.2rem] flex-1 flex-col items-center justify-center gap-1 rounded-[0.9rem] px-1.5 transition ${
                  active
                    ? 'bg-slate-900 text-white shadow-[0_8px_18px_rgba(15,23,42,0.12)]'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                } disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none`}
              >
                <Icon className="h-4.5 w-4.5" />
                <span className="whitespace-nowrap text-[9px] font-semibold leading-none tracking-[-0.01em]">
                  {option}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
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

function hasActiveSelectionStatus(item) {
  return item?.status === 'active'
}

function chooseStackLead(items) {
  return [...items].sort((a, b) => {
    const activeCompare = Number(hasActiveStayOrMealStatus(b)) - Number(hasActiveStayOrMealStatus(a))
    if (activeCompare !== 0) return activeCompare
    return itemInterval(a).start - itemInterval(b).start
  })[0]
}

function chooseSubstituteStackLead(items) {
  return [...items].sort((a, b) => {
    const activeCompare = Number(hasActiveSelectionStatus(b)) - Number(hasActiveSelectionStatus(a))
    if (activeCompare !== 0) return activeCompare
    const sourceCompare = Number(Boolean(a.substituteOfItemId)) - Number(Boolean(b.substituteOfItemId))
    if (sourceCompare !== 0) return sourceCompare
    return itemInterval(a).start - itemInterval(b).start
  })[0]
}

function buildTimelineEntries(items) {
  const stackByItemId = new Map()

  Object.values(
    items.reduce((groups, item) => {
      if (!item.substituteGroupId) return groups
      groups[item.substituteGroupId] = groups[item.substituteGroupId] || []
      groups[item.substituteGroupId].push(item)
      return groups
    }, {}),
  )
    .filter((groupItems) => groupItems.length > 1)
    .forEach((groupItems) => {
      const leadItem = chooseSubstituteStackLead(groupItems)
      const stack = {
        id: `substitute-stack:${leadItem.substituteGroupId}`,
        type: 'stack',
        stackKind: 'substitute',
        dayId: leadItem.dayId,
        item: leadItem,
        items: [leadItem, ...groupItems.filter((item) => item.id !== leadItem.id)],
      }
      groupItems.forEach((item) => stackByItemId.set(item.id, stack))
    })

  Object.values(
    items.filter((item) => isStackableStayOrMeal(item) && !stackByItemId.has(item.id)).reduce((groups, item) => {
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

function buildRouteTimelineItems(items) {
  return buildTimelineEntries(items).map((entry) => entry.item)
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
      note: 'Review now',
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
      note: 'Upcoming deadline',
      card: 'border-amber-200 bg-amber-50/80',
      rail: 'bg-amber-500',
      badge: 'bg-amber-100 text-amber-800',
      deadline: 'text-amber-800',
    }
  }

  if (state === 'no_deadline') {
    return {
      label: 'No deadline added',
      note: 'Add deadline',
      card: 'border-slate-200 bg-white',
      rail: 'bg-slate-300',
      badge: 'bg-slate-100 text-slate-600',
      deadline: 'text-slate-500',
    }
  }

  if (state === 'invalid_deadline') {
    return {
      label: 'Review date',
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

function bookingOptionToCancellationEntry(booking, linkedItem) {
  const reservationDate = booking.reservationTime?.slice(0, 10) || linkedItem?.dayDate || ''
  const reservationTime = booking.reservationTime?.slice(11, 16) || linkedItem?.startTime || ''

  return {
    id: `booking-option:${booking.id}`,
    sourceBookingId: booking.id,
    sourceItemId: booking.linkedItemId || '',
    dayId: booking.dayId || linkedItem?.dayId || '',
    dayDate: reservationDate,
    dayLabel: reservationDate ? formatDayDate(reservationDate) : linkedItem?.dayLabel || '',
    category: booking.type === 'meal' ? 'Restaurant' : 'Hotel',
    title: booking.title || linkedItem?.title || 'Untitled booking',
    locationName: booking.title || linkedItem?.locationName || '',
    startTime: reservationTime,
    endTime: '',
    status: booking.status === 'active' ? 'active' : 'considering',
    cancellationDeadline: booking.cancellationDeadline || '',
    bookingRef: booking.bookingRef || '',
    isBookingOption: true,
  }
}

function sortedCancellationEntries(items, bookingOptions = []) {
  const itemLookup = Object.fromEntries(items.map((item) => [item.id, item]))
  const bookingEntries = bookingOptions
    .filter((booking) => !booking.hidden && booking.status !== 'cancelled')
    .map((booking) => bookingOptionToCancellationEntry(booking, itemLookup[booking.linkedItemId]))

  return [...items.filter(isMonitoredCancellationItem), ...bookingEntries].sort((a, b) => {
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

function routeIconForMode(mode) {
  if (mode === 'walking') return Footprints
  if (mode === 'transit') return TrainFront
  return CarFront
}

function routeDurationText(segment) {
  if (!segment?.route) return 'Loading'
  return `${segment.route.estimated ? '~' : ''}${Math.round(segment.route.durationMin)} min`
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
        className="inline-flex h-6 items-center gap-1 rounded-full bg-white/96 px-2 text-[10px] font-semibold tracking-[-0.01em] text-slate-600 transition hover:bg-white"
      >
        <span>{activeOption.label}</span>
        <ChevronDown className={`h-3 w-3 text-slate-400 transition ${open ? 'rotate-180' : ''}`} />
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
                className={`flex min-h-9 w-full items-center justify-between rounded-[0.75rem] px-2.5 text-left text-[11px] font-medium tracking-[-0.01em] transition ${
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
      detail: 'Checking weather for this day.',
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
    const tempMax = typeof selectedWeather.tempMax === 'number' ? Math.round(selectedWeather.tempMax) : null
    const rainProbability = selectedWeather.rainProbability ?? 0

    if (selectedWeather.historical) {
      return {
        headline: tempMax === null ? 'Typical weather' : `Typical ${tempMax}°C`,
        detail: '',
        icon: rainProbability >= 40 ? CloudRain : Sun,
        compact: tempMax === null ? 'Typical weather' : `Typical ${tempMax}°C`,
      }
    }

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
    date: '',
    lat: null,
    lng: null,
    placeId: '',
  }
}

function buildDefaultTripSummary() {
  return {
    id: TRIP_ID,
    title: DEFAULT_TRIP_TITLE,
    role: 'owner',
    hidden: false,
    startDate: SEED_DAYS[0]?.date || '',
    endDate: SEED_DAYS[SEED_DAYS.length - 1]?.date || '',
    city: '',
  }
}

function readLocalTripOverrides() {
  if (typeof window === 'undefined') {
    return { days: {}, items: {}, bookingOptions: {} }
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_TRIP_OVERRIDES_KEY) || '')
    return {
      days: parsed?.days || {},
      items: parsed?.items || {},
      bookingOptions: parsed?.bookingOptions || {},
    }
  } catch {
    return { days: {}, items: {}, bookingOptions: {} }
  }
}

function readInviteIdFromUrl() {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('invite') || ''
}

function hasTripOverrides(overrides) {
  return ['days', 'items', 'bookingOptions'].some(
    (key) => Object.keys(overrides?.[key] || {}).length > 0,
  )
}

function buildLocalTripSummaries(overrides) {
  return hasTripOverrides(overrides) ? [buildDefaultTripSummary()] : []
}

function mergeTripOverrides(current, patch) {
  return {
    days: { ...(current.days || {}), ...(patch.days || {}) },
    items: { ...(current.items || {}), ...(patch.items || {}) },
    bookingOptions: { ...(current.bookingOptions || {}), ...(patch.bookingOptions || {}) },
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

const PDF_CJK_FONT_NAME = 'NotoSansJP'
const PDF_CJK_FONT_FILE = 'NotoSansJP.ttf'
let pdfCjkFontDataPromise = null

function arrayBufferToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }

  return binary
}

async function registerPdfCjkFont(doc) {
  try {
    if (!pdfCjkFontDataPromise) {
      pdfCjkFontDataPromise = fetch('/fonts/NotoSansJP.ttf')
        .then((response) => {
          if (!response.ok) throw new Error(`Font download failed: ${response.status}`)
          return response.arrayBuffer()
        })
        .then(arrayBufferToBinaryString)
    }

    const fontData = await pdfCjkFontDataPromise
    doc.addFileToVFS(PDF_CJK_FONT_FILE, fontData)
    doc.addFont(PDF_CJK_FONT_FILE, PDF_CJK_FONT_NAME, 'normal')
    doc.addFont(PDF_CJK_FONT_FILE, PDF_CJK_FONT_NAME, 'bold')
    return PDF_CJK_FONT_NAME
  } catch (error) {
    console.warn('CJK PDF font could not be loaded; falling back to built-in PDF font.', error)
    return 'helvetica'
  }
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

async function createTripOverviewPdf({ days, items, tripSummary }) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pdfFont = await registerPdfCjkFont(doc)
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
    doc.setFont(pdfFont, style)
    doc.setFontSize(size)
    doc.setTextColor(...color)
    const lines = doc.splitTextToSize(cleanText, maxWidth)
    ensureSpace(lines.length * lineHeight)
    doc.text(lines, x, y)
    y += lines.length * lineHeight
    return lines.length * lineHeight
  }

  doc.setFont(pdfFont, 'bold')
  doc.setFontSize(24)
  doc.setTextColor(15, 23, 42)
  doc.text(pdfSafeText(tripSummary.title || 'Trip overview'), page.marginX, y)
  y += 22

  doc.setFont(pdfFont, 'normal')
  doc.setFontSize(10)
  doc.setTextColor(100, 116, 139)
  doc.text(formatTripDateRange(tripSummary.startDate, tripSummary.endDate), page.marginX, y)
  y += 30

  days.forEach((day, dayIndex) => {
    const dayItems = exportItemsForDay(items, day.id)
    ensureSpace(72)
    doc.setDrawColor(226, 232, 240)
    doc.line(page.marginX, y, page.width - page.marginX, y)
    y += 22

    doc.setFont(pdfFont, 'bold')
    doc.setFontSize(13)
    doc.setTextColor(15, 23, 42)
    doc.text(pdfSafeText(`${day.label || `Day ${dayIndex + 1}`} - ${formatFullDayDate(day.date)}`), page.marginX, y)
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
      doc.setFont(pdfFont, 'bold')
      doc.setFontSize(10)
      doc.setTextColor(15, 23, 42)
      doc.text(timeLabel, page.marginX, y)

      const contentX = page.marginX + 82
      doc.setFont(pdfFont, 'bold')
      doc.setFontSize(10.5)
      doc.setTextColor(15, 23, 42)
      doc.text(pdfSafeText(item.title || 'Untitled stop'), contentX, y)
      y += 14

      const locationLine = [item.category, item.locationName || item.address].filter(Boolean).join(' · ')
      writeWrapped(locationLine, contentX, { color: [100, 116, 139], size: 8.8, lineHeight: 12 })

      const transitLine = buildTransitSummary(item)
      if (transitLine) {
        writeWrapped(transitLine, contentX, { color: [100, 116, 139], size: 8.8, lineHeight: 12 })
      }

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
    doc.setFont(pdfFont, 'normal')
    doc.setFontSize(8)
    doc.setTextColor(148, 163, 184)
    doc.text(`Generated from Trip Planner · Page ${pageNumber} of ${pageCount}`, page.marginX, page.height - 24)
  }

  return doc.output('blob')
}

async function CREATE_TRIP_OVERVIEW_PDF_IMAGE_LEGACY({ days, items, tripSummary }) {
  const { jsPDF } = await import('jspdf')
  const html2canvas = null
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
  container.style.cssText = 'position:absolute;left:-10000px;top:0;width:794px;background:#f7f8fa;'
  container.innerHTML = `
    <div class="pdf-root">
      <style>
        .pdf-root {
          box-sizing: border-box;
          width: 794px;
          padding: 56px 58px 48px;
          background: #f7f8fa;
          color: #111111;
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
        .time { color: #111111; font-size: 12px; font-weight: 800; letter-spacing: -0.01em; }
        .title { color: #111111; font-size: 14px; line-height: 1.35; font-weight: 800; letter-spacing: -0.02em; }
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
      backgroundColor: '#f7f8fa',
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

  if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
    const error = new Error('PDF file sharing is not supported in this browser.')
    error.name = 'NotSupportedError'
    throw error
  }

  await navigator.share({
    files: [file],
    title: `${tripSummary.title || 'Trip'} overview`,
    text: 'Trip overview PDF',
  })
}

async function downloadTripOverviewPdf({ days, items, tripSummary }) {
  const filename = buildTripOverviewFilename(tripSummary.title)
  const blob = await createTripOverviewPdf({ days, items, tripSummary })
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

function isoDateToUtcMs(date) {
  const [year, month, day] = String(date || '').split('-').map(Number)
  if (!year || !month || !day) return NaN
  return Date.UTC(year, month - 1, day)
}

function utcMsToIsoDate(value) {
  return new Date(value).toISOString().slice(0, 10)
}

function enumerateTripDates(startDate, endDate) {
  const start = isoDateToUtcMs(startDate)
  const end = isoDateToUtcMs(endDate)
  if (!Number.isFinite(start)) return [localTodayIso()]

  const safeEnd = Number.isFinite(end) && end >= start ? end : start
  const dates = []
  for (let cursor = start; cursor <= safeEnd; cursor += 86_400_000) {
    dates.push(utcMsToIsoDate(cursor))
  }
  return dates
}

function buildBlankTripSnapshot(startDate = localTodayIso(), endDate = startDate) {
  const dates = enumerateTripDates(startDate, endDate)
  const days = dates.map((date, index) => ({
    id: slugId('day'),
    date,
    name: '',
    order: index,
  }))

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    days: {
      ...Object.fromEntries(SEED_DAYS.map((day) => [day.id, { ...day, hidden: true }])),
      ...Object.fromEntries(days.map((day) => [day.id, day])),
    },
    items: Object.fromEntries(SEED_ITEMS.map((item) => [item.id, { ...item, hidden: true }])),
    bookingOptions: {},
  }
}

function deriveItemTitle(item) {
  const fallback = item.locationName || item.description || item.address || item.category || 'Untitled stop'
  return (item.title || '').trim() || fallback.trim?.() || 'Untitled stop'
}

function normalizeItemForSave(item) {
  return {
    ...item,
    title: deriveItemTitle(item),
  }
}

function buildClonedTripSnapshot(tripState) {
  const dayIdMap = Object.fromEntries(tripState.days.map((day) => [day.id, slugId('day')]))
  const cloneableItems = [...tripState.items, ...(tripState.parkingLotItems || [])].filter(
    (item) => !item.generated && !item.hidden,
  )
  const itemIdMap = Object.fromEntries(
    cloneableItems.map((item) => [item.id, slugId('item')]),
  )

  const days = {
    ...Object.fromEntries(SEED_DAYS.map((day) => [day.id, { ...day, hidden: true }])),
    ...Object.fromEntries(
      tripState.days.map((day, index) => {
        const id = dayIdMap[day.id]
        return [
          id,
          {
            id,
            date: day.date,
            name: day.name || '',
            order: index,
          },
        ]
      }),
    ),
  }

  const items = {
    ...Object.fromEntries(SEED_ITEMS.map((item) => [item.id, { ...item, hidden: true }])),
    ...Object.fromEntries(
      cloneableItems
        .filter((item) => itemIdMap[item.id])
        .map((item) => {
          const id = itemIdMap[item.id]
          return [
            id,
            normalizeItemForSave({
              ...item,
              id,
              dayId: dayIdMap[item.dayId] || item.dayId,
              sourceItemId: item.sourceItemId ? itemIdMap[item.sourceItemId] || item.sourceItemId : undefined,
            }),
          ]
        }),
    ),
  }

  const bookingOptions = Object.fromEntries(
    tripState.bookingOptions
      .filter((booking) => !booking.hidden)
      .map((booking) => {
        const id = slugId('booking')
        return [
          id,
          {
            ...booking,
            id,
            linkedItemId: itemIdMap[booking.linkedItemId] || booking.linkedItemId || '',
            dayId: dayIdMap[booking.dayId] || booking.dayId || '',
          },
        ]
      }),
  )

  return {
    startDate: tripState.days[0]?.date || '',
    endDate: tripState.days[tripState.days.length - 1]?.date || '',
    days,
    items,
    bookingOptions,
  }
}

function formatBookingDateTime(value) {
  if (!value) return 'No deadline added'
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

function isLocatedItem(item) {
  return typeof item?.lat === 'number' && typeof item?.lng === 'number'
}

function buildWeatherTargetFromItem(item, day) {
  if (!item || !day) return null

  return {
    lat: item.lat,
    lng: item.lng,
    date: day.date,
    label: item.locationName || item.address || item.title || '',
  }
}

function getWeatherTargetForDay(activeDayId, tripState) {
  if (activeDayId === DAY_VIEW_ALL) return null

  const activeDayIndex = tripState.days.findIndex((day) => day.id === activeDayId)
  const activeDay = tripState.days[activeDayIndex]
  if (!activeDay) return null

  const activeDayLocation = sortItemsByTimeline(activeDay.items || []).find(isLocatedItem)
  if (activeDayLocation) return buildWeatherTargetFromItem(activeDayLocation, activeDay)

  for (let dayIndex = activeDayIndex - 1; dayIndex >= 0; dayIndex -= 1) {
    const day = tripState.days[dayIndex]
    const previousLocations = sortItemsByTimeline(day.items || []).filter(isLocatedItem)
    const previousLocation = previousLocations[previousLocations.length - 1]
    if (previousLocation) return buildWeatherTargetFromItem(previousLocation, activeDay)
  }

  return null
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
            setError('Place search is temporarily unavailable.')
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
          setError('We could not load that place. Try another result.')
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
        Select a Google Places suggestion
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
  function applyPlaceSelection(place) {
    onChange({
      ...place,
      title: (draft.title || '').trim() ? draft.title : place.locationName || draft.title,
    })
  }

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
          onSelect={applyPlaceSelection}
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

const TIME_MODE_ROW_CLASS = 'time-mode-row'

function TimeField({ conflict, disabled, label, onChange, value }) {
  return (
    <label className="block min-w-0">
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
        className={`time-field-input w-full min-w-0 rounded-[1.15rem] border bg-white px-3.5 py-3 text-[14px] tracking-[-0.01em] disabled:bg-slate-100 ${
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

function EndTimeModeToggle({ disabled, draft, onChange }) {
  const activeMode =
    draft.endTimeMode === 'duration'
      ? 'duration'
      : draft.endTimeMode === 'none'
        ? 'none'
        : 'time'
  const derivedEndTime = deriveEndTimeFromDuration(draft.startTime, draft.durationMinutes)

  return (
    <div className="inline-flex min-h-11 w-full min-w-0 items-center rounded-full border border-slate-200/90 bg-slate-100 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ endTimeMode: 'time' })}
        className={`min-h-9 flex-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold transition ${
          activeMode === 'time'
            ? 'bg-slate-900 text-white shadow-[0_6px_14px_rgba(15,23,42,0.12)]'
            : 'text-slate-600'
        } disabled:text-slate-400`}
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
        className={`min-h-9 flex-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold transition ${
          activeMode === 'duration'
            ? 'bg-slate-900 text-white shadow-[0_6px_14px_rgba(15,23,42,0.12)]'
            : 'text-slate-600'
        } disabled:text-slate-400`}
      >
        Duration
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ endTime: '', endTimeMode: 'none', durationMinutes: null })}
        className={`min-h-9 flex-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold transition ${
          activeMode === 'none'
            ? 'bg-slate-900 text-white shadow-[0_6px_14px_rgba(15,23,42,0.12)]'
            : 'text-slate-600'
        } disabled:text-slate-400`}
        title={derivedEndTime ? `Leave blank instead of ending at ${derivedEndTime}` : 'Leave end time blank'}
      >
        No end
      </button>
    </div>
  )
}

function EndTimeModeSpacer() {
  return (
    <div
      className="invisible inline-flex min-h-11 w-full min-w-0 items-center rounded-full border border-slate-200/90 bg-slate-100 p-1"
      aria-hidden="true"
    >
      <span className="min-h-9 flex-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold">End time</span>
      <span className="min-h-9 flex-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold">Duration</span>
      <span className="min-h-9 flex-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold">No end</span>
    </div>
  )
}

function StartTimeModeRow({
  conflict = false,
  disabled = false,
  draft,
  onChange,
  showModeToggle = true,
}) {
  return (
    <div className={`${TIME_MODE_ROW_CLASS} sm:col-span-2`}>
      <TimeField
        label="Start time"
        value={draft.startTime}
        onChange={(event) => onChange({ startTime: event.target.value })}
        disabled={disabled}
        conflict={conflict}
      />
      {showModeToggle ? (
        <EndTimeModeToggle disabled={disabled} draft={draft} onChange={onChange} />
      ) : null}
    </div>
  )
}

function EndTimeModeField({ conflict = false, disabled, draft, onChange, showModeToggle = true }) {
  const derivedEndTime =
    draft.endTimeMode === 'duration'
      ? deriveEndTimeFromDuration(draft.startTime, draft.durationMinutes)
      : draft.endTime

  return (
    <div className="space-y-3 sm:col-span-2">
      {showModeToggle ? <EndTimeModeToggle disabled={disabled} draft={draft} onChange={onChange} /> : null}

      {draft.endTimeMode === 'none' ? (
        <div className={TIME_MODE_ROW_CLASS}>
          <Field label="End time" className="min-w-0">
            <div className="time-field-input w-full min-w-0 rounded-[1.15rem] border border-slate-200/90 bg-slate-50 px-3.5 py-3 text-[14px] font-semibold tracking-[-0.01em] text-slate-500">
              No end time
            </div>
          </Field>
          {!showModeToggle ? <EndTimeModeSpacer /> : null}
        </div>
      ) : draft.endTimeMode === 'time' ? (
        <div className={TIME_MODE_ROW_CLASS}>
          <TimeField
            label="End time"
            value={draft.endTime}
            onChange={(event) => onChange({ endTime: event.target.value })}
            disabled={disabled}
            conflict={conflict}
          />
          {!showModeToggle ? <EndTimeModeSpacer /> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div className={TIME_MODE_ROW_CLASS}>
            <Field label="End time" className="min-w-0">
              <div className="time-field-input w-full min-w-0 rounded-[1.15rem] border border-slate-200/90 bg-slate-50 px-3.5 py-3 text-[14px] font-semibold tracking-[-0.01em] text-slate-700">
                {derivedEndTime || '--:--'}
              </div>
            </Field>
            <Field label="Duration (minutes)" className="min-w-0">
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
          </div>
          <div>
            <div className="text-[11px] leading-5 text-slate-500">
              Enter a duration and the itinerary will calculate the end time.
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {DURATION_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ durationMinutes: preset.value })}
                  className={`min-h-11 rounded-full px-3 text-[11px] font-semibold transition ${
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
  canDeleteTrip,
  canEditTrip,
  deletedTrips,
  disabled,
  isMobilePortrait,
  onCloneTrip,
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

  async function handleCloneTrip() {
    setOpen(false)
    await onCloneTrip()
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
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="truncate text-[13px] font-semibold tracking-[-0.01em] text-slate-900 sm:text-[14px]">
              {activeTrip?.title || 'Select trip'}
            </div>
            {activeTrip?.isDemo ? (
              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.14em] text-slate-500">
                Demo
              </span>
            ) : null}
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
          <div className="overflow-hidden rounded-[1rem] border border-slate-200/90 bg-white/95 p-1.5 shadow-[0_16px_30px_rgba(15,23,42,0.075)]">
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
                      <div className="flex min-w-0 items-center gap-1.5">
                        <div className="truncate text-[13px] font-semibold tracking-[-0.01em]">{trip.title}</div>
                        {trip.isDemo ? (
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.14em] ${
                              selected ? 'bg-white/12 text-slate-200' : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            Demo
                          </span>
                        ) : null}
                      </div>
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
              <div className="grid grid-cols-3 gap-1 px-1 pb-1">
                <button
                  type="button"
                  onClick={() => void onRenameTrip()}
                  disabled={disabled || !activeTrip || !canEditTrip}
                  className="flex min-h-11 items-center justify-center gap-2 rounded-[0.78rem] px-3 text-[12px] font-semibold text-slate-600 transition hover:bg-white/80 disabled:text-slate-400"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => void handleCloneTrip()}
                  disabled={disabled || !activeTrip || !canEditTrip}
                  className="flex min-h-11 items-center justify-center gap-2 rounded-[0.78rem] px-3 text-[12px] font-semibold text-slate-600 transition hover:bg-white/80 disabled:text-slate-400"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Clone
                </button>
                <button
                  type="button"
                  onClick={() => void onDeleteTrip()}
                  disabled={disabled || !activeTrip || !canDeleteTrip || activeTrip.id === TRIP_ID}
                  className="flex min-h-11 items-center justify-center gap-2 rounded-[0.78rem] px-3 text-[12px] font-semibold text-rose-600 transition hover:bg-rose-50 disabled:text-slate-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
              {canDeleteTrip && deletedTrips.length ? (
                <div className="border-t border-slate-200/70 px-1 pt-1.5">
                  <div className="px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Hidden trips
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
                  <div className="pt-0.5 text-[11px] text-slate-500">Create another itinerary.</div>
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

function AccountPanel({ authError, isGuestMode, user, onSignIn, onSignOut }) {
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
            {user?.displayName || (isGuestMode ? 'Offline mode' : 'Signed in')}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-500">
            {isGuestMode ? 'Saved on this device' : user?.email || ''}
          </div>
        </div>
      </div>
      <div className="mt-2">
        <button
          type="button"
          onClick={isGuestMode ? onSignIn : onSignOut}
          disabled={isGuestMode && !firebaseEnabled}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[0.8rem] bg-white px-3 text-[12px] font-semibold text-slate-700 transition hover:bg-slate-50"
        >
          {isGuestMode ? <Cloud className="h-3.5 w-3.5" /> : <LogOut className="h-3.5 w-3.5" />}
          {isGuestMode ? 'Sign in' : 'Sign out'}
        </button>
      </div>
      {authError ? (
        <div className="mt-2 rounded-[0.75rem] bg-rose-50 px-3 py-2 text-[11px] leading-5 text-rose-700">
          {authError}
        </div>
      ) : null}
    </div>
  )
}

function AppDrawer({
  activeTripSummary,
  authError,
  availableTrips,
  canDeleteCurrentTrip,
  canEditCurrentTrip,
  canShare,
  currentUser,
  deletedTrips,
  disabled,
  isGuestMode,
  isMobilePortrait,
  onCloneTrip,
  onClose,
  onCreateTrip,
  onDeleteTrip,
  onExportOverview,
  onOpenDeadlines,
  onOpenItinerary,
  onOpenParkingLot,
  onRenameTrip,
  onRestoreTrip,
  onSelectTrip,
  onShare,
  onSignIn,
  onSignOut,
  open,
  pdfExporting,
  showingUtilityScreen,
  urgentDeadlineCount,
}) {
  return (
    <>
      <div
        onClick={open ? onClose : undefined}
        className={`premium-backdrop fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[2px] transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        aria-hidden="true"
      />
      <aside
        className={`app-drawer fixed bottom-0 left-0 top-0 z-50 flex w-[min(22rem,calc(100vw-1.4rem))] flex-col border-r border-white/70 bg-white/96 px-3.5 py-4 shadow-[18px_0_42px_rgba(15,23,42,0.11)] transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-1 pb-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Trip menu</div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.05)]"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2.5">
          <TripSwitcher
            activeTripId={activeTripSummary?.id || ''}
            canDeleteTrip={canDeleteCurrentTrip}
            canEditTrip={canEditCurrentTrip}
            deletedTrips={deletedTrips}
            disabled={disabled}
            isMobilePortrait={isMobilePortrait}
            onCloneTrip={onCloneTrip}
            onCreateTrip={onCreateTrip}
            onDeleteTrip={onDeleteTrip}
            onRenameTrip={onRenameTrip}
            onRestoreTrip={onRestoreTrip}
            onSelectTrip={onSelectTrip}
            tripSummaries={availableTrips}
          />
          {showingUtilityScreen ? (
            <button
              type="button"
              onClick={onOpenItinerary}
              className="flex w-full items-center justify-between rounded-[0.95rem] border border-slate-200/70 bg-white/90 px-3.5 py-3 text-left text-slate-800 transition hover:bg-white"
            >
              <span>
                <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Itinerary
                </span>
                <span className="mt-1 block text-[13px] font-semibold">
                  Back to main trip screen
                </span>
              </span>
              <ArrowLeft className="h-4 w-4 text-slate-500" />
            </button>
          ) : null}
          {availableTrips.length ? (
            <>
              <button
                type="button"
                onClick={onShare}
                disabled={!canShare}
                className="flex w-full items-center justify-between rounded-[0.95rem] border border-slate-200/70 bg-white/90 px-3.5 py-3 text-left text-slate-800 transition hover:bg-white disabled:text-slate-400"
              >
                <span>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Share trip
                  </span>
                  <span className="mt-1 block text-[13px] font-semibold">
                    Invite people to this itinerary
                  </span>
                </span>
                <Users className="h-4 w-4 text-slate-500" />
              </button>
              <button
                type="button"
                onClick={onExportOverview}
                disabled={pdfExporting}
                className="flex w-full items-center justify-between rounded-[0.95rem] border border-slate-200/70 bg-white/90 px-3.5 py-3 text-left text-slate-800 transition hover:bg-white disabled:cursor-wait disabled:text-slate-400"
              >
                <span>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    Itinerary PDF
                  </span>
                  <span className="mt-1 block text-[13px] font-semibold">
                    {pdfExporting ? 'Preparing PDF' : 'Share or download itinerary'}
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
              <button
                type="button"
                onClick={onOpenParkingLot}
                className="flex w-full items-center justify-between rounded-[0.95rem] border border-slate-200/70 bg-white/90 px-3.5 py-3 text-left text-slate-800 transition hover:bg-white"
              >
                <span>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">
                    The Parking Lot
                  </span>
                  <span className="mt-1 block text-[13px] font-semibold">
                    Park your ideas here. Figure it out later!
                  </span>
                </span>
                <PackageOpen className="h-4 w-4 text-slate-500" />
              </button>
            </>
          ) : null}
        </div>

        <div className="mt-auto pt-4">
          <AccountPanel
            authError={authError}
            isGuestMode={isGuestMode}
            user={currentUser}
            onSignIn={onSignIn}
            onSignOut={onSignOut}
          />
        </div>
      </aside>
    </>
  )
}

function PdfExportSheet({ loading, onClose, onDownload, onShare, open }) {
  if (!open) return null

  return (
    <div
      className="premium-backdrop fixed inset-0 z-[70] flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="premium-modal w-full max-w-[min(24rem,calc(100vw-1.5rem))] overflow-x-hidden rounded-[1.45rem] border border-white/70 bg-white/96 p-4 shadow-[0_24px_70px_rgba(15,23,42,0.18)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Itinerary PDF</div>
            <h2 className="mt-1 text-xl font-extrabold tracking-[-0.04em] text-slate-950">
              Export overview
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-slate-500">
              Choose how to save or share this itinerary.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.05)]"
            aria-label="Close export options"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 grid gap-2">
          <button
            type="button"
            onClick={onShare}
            disabled={loading}
            className="flex w-full items-center justify-between rounded-[1rem] border border-slate-200/80 bg-white px-3.5 py-3 text-left transition hover:bg-slate-50 disabled:cursor-wait disabled:text-slate-400"
          >
            <span>
              <span className="block text-sm font-bold text-slate-900">Share</span>
              <span className="mt-0.5 block text-xs font-medium text-slate-500">Share from this device</span>
            </span>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4 text-slate-500" />}
          </button>
          <button
            type="button"
            onClick={onDownload}
            disabled={loading}
            className="flex w-full items-center justify-between rounded-[1rem] border border-slate-200/80 bg-white px-3.5 py-3 text-left transition hover:bg-slate-50 disabled:cursor-wait disabled:text-slate-400"
          >
            <span>
              <span className="block text-sm font-bold text-slate-900">Download</span>
              <span className="mt-0.5 block text-xs font-medium text-slate-500">Download itinerary PDF</span>
            </span>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4 text-slate-500" />}
          </button>
        </div>
      </div>
    </div>
  )
}

function MenuButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-panel floating-menu-button fixed z-30 flex h-11 w-11 items-center justify-center rounded-full text-slate-700 transition hover:bg-white"
      aria-label="Open menu"
    >
      <Menu className="h-4 w-4" />
    </button>
  )
}

function useVisualViewportBottomOffset() {
  const [bottomOffset, setBottomOffset] = useState(0)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return undefined

    let frame = 0
    const update = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        setBottomOffset(Math.round(offset))
      })
    }

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    window.addEventListener('orientationchange', update)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  return bottomOffset
}

function BottomDayNav({
  activeDayId,
  dayOptions,
  dragState,
  focusedDayId,
  onDayChange,
  onManageDays,
  canEdit,
  overbookingCountsByDay = {},
}) {
  const dayNavRef = useRef(null)
  const bottomOffset = useVisualViewportBottomOffset()
  const dayPressRef = useRef({
    timer: null,
    dayId: '',
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
    longPressed: false,
  })

  function clearDayPress() {
    const state = dayPressRef.current
    if (state.timer) window.clearTimeout(state.timer)
    dayPressRef.current = {
      timer: null,
      dayId: '',
      pointerId: null,
      startX: 0,
      startY: 0,
      moved: false,
      longPressed: false,
    }
  }

  function startDayPress(event, dayId) {
    if (!canEdit) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    clearDayPress()
    dayPressRef.current = {
      timer: window.setTimeout(() => {
        const state = dayPressRef.current
        if (!state.moved && state.dayId === dayId) {
          dayPressRef.current.longPressed = true
          onDayChange(dayId)
          onManageDays(dayId)
        }
      }, LONG_PRESS_MS),
      dayId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      longPressed: false,
    }
  }

  function moveDayPress(event) {
    const state = dayPressRef.current
    if (state.pointerId !== event.pointerId) return
    const movedX = Math.abs(event.clientX - state.startX)
    const movedY = Math.abs(event.clientY - state.startY)
    if (movedX > MOVE_THRESHOLD || movedY > MOVE_THRESHOLD) {
      dayPressRef.current.moved = true
      if (state.timer) {
        window.clearTimeout(state.timer)
        dayPressRef.current.timer = null
      }
    }
  }

  function handleDayClick(event, dayId) {
    if (dayPressRef.current.longPressed) {
      event.preventDefault()
      clearDayPress()
      return
    }
    clearDayPress()
    onDayChange(dayId)
  }

  useEffect(() => clearDayPress, [])

  useEffect(() => {
    if (!focusedDayId) return
    const target = dayNavRef.current?.querySelector(`[data-day-drop-id="${focusedDayId}"]`)
    target?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [focusedDayId])

  const nav = (
    <div
      className="bottom-day-nav-shell fixed inset-x-0 z-30 px-2.5 pb-[max(0.65rem,env(safe-area-inset-bottom))] sm:px-4"
      style={{ bottom: bottomOffset }}
    >
      <div className="bottom-day-nav mx-auto flex max-w-5xl items-center gap-1 rounded-[1.05rem] border border-white/80 bg-white/95 p-1.5 shadow-[0_-10px_24px_rgba(15,23,42,0.075)]">
        <button
          type="button"
          onClick={() => onDayChange(DAY_VIEW_ALL)}
          aria-label="Trip overview"
          className={`relative flex h-12 min-w-[4.7rem] shrink-0 flex-col items-center justify-center rounded-[0.8rem] px-3 text-center transition ${
            activeDayId === DAY_VIEW_ALL ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-white'
          }`}
        >
          <span className="text-[10px] font-extrabold uppercase leading-3 tracking-[0.07em]">Trip</span>
          <span className={`mt-0.5 text-[10px] font-semibold leading-3 ${activeDayId === DAY_VIEW_ALL ? 'text-white/70' : 'text-slate-400'}`}>
            Overview
          </span>
        </button>
        <div className="h-8 w-px shrink-0 bg-slate-200/70" />
        <div className="relative min-w-0 flex-1">
          <div
            ref={dayNavRef}
            className="no-scrollbar flex snap-x gap-1 overflow-x-auto scroll-px-1 pr-4 md:justify-center"
            aria-label="Day navigation"
          >
          {dayOptions.map((day, index) => {
            const overbookingCount = Number(overbookingCountsByDay[day.id] || 0)
            const isActiveDay = activeDayId === day.id
            const isFocusedOverviewDay = activeDayId === DAY_VIEW_ALL && focusedDayId === day.id
            return (
              <button
                key={day.id}
                type="button"
                data-day-drop-id={day.id}
                onPointerDown={(event) => startDayPress(event, day.id)}
                onPointerMove={moveDayPress}
                onPointerUp={() => {
                  if (!dayPressRef.current.longPressed) clearDayPress()
                }}
                onPointerCancel={clearDayPress}
                onPointerLeave={clearDayPress}
                onClick={(event) => handleDayClick(event, day.id)}
                className={`relative flex h-12 min-w-[4.55rem] shrink-0 snap-start flex-col items-center justify-center rounded-[0.8rem] px-2 text-center transition ${
                  dragState?.overDayId === day.id
                    ? 'bg-slate-200 text-slate-800 ring-1 ring-slate-300'
                    : isActiveDay
                      ? 'bg-slate-900 text-white'
                      : isFocusedOverviewDay
                        ? 'bg-slate-700 text-white ring-1 ring-slate-600 shadow-[0_6px_16px_rgba(15,23,42,0.20)]'
                      : 'text-slate-600 hover:bg-white'
                }`}
                aria-label={`Day ${index + 1} ${formatDayDate(day.date)}`}
                aria-current={isActiveDay || isFocusedOverviewDay ? 'true' : undefined}
              >
                <span className="text-[10px] font-extrabold uppercase leading-3 tracking-[0.06em]">
                  Day {index + 1}
                </span>
                <span className={`mt-0.5 text-[10px] font-semibold leading-3 ${
                  isActiveDay || isFocusedOverviewDay ? 'text-white/72' : 'text-slate-400'
                }`}>
                  {formatDayDate(day.date)}
                </span>
                {overbookingCount > 0 ? (
                  <span className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[9px] font-bold leading-none text-white shadow-[0_2px_8px_rgba(190,18,60,0.28)]">
                    {formatBadgeCount(overbookingCount)}
                  </span>
                ) : null}
              </button>
            )
          })}
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-white/95 to-transparent" />
        </div>
        <div className="h-8 w-px shrink-0 bg-slate-200/70" />
        <button
          type="button"
          onClick={onManageDays}
          disabled={!canEdit}
          className="flex h-12 min-w-[4.2rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[0.8rem] bg-white/90 px-2 text-slate-600 transition hover:bg-white disabled:text-slate-300"
          aria-label="Manage days"
        >
          <CalendarDays className="h-4 w-4" />
          <span className="text-[10px] font-bold leading-3">Manage</span>
        </button>
      </div>
    </div>
  )

  return createPortal(nav, document.body)
}

function CollaboratorsModal({
  canManageTrip,
  currentRole,
  currentUser,
  isMobilePortrait,
  members,
  onAddMember,
  onClose,
  onCreateInvite,
  onRemoveMember,
  onUpdateRole,
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('editor')
  const [inviteRole, setInviteRole] = useState('viewer')
  const [inviteLink, setInviteLink] = useState('')
  const [busy, setBusy] = useState(false)
  const canManage = canManageTrip ?? canManageMembers(currentRole)

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

  async function handleCreateInvite() {
    setBusy(true)
    try {
      const link = await onCreateInvite(inviteRole)
      if (link) setInviteLink(link)
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyInvite() {
    if (!inviteLink) return
    try {
      await navigator.clipboard?.writeText(inviteLink)
    } catch (error) {
      console.error(error)
    }
  }

  async function handleShareInvite() {
    if (!inviteLink) return
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Trip invitation',
          text: `Join this trip as ${roleLabel(inviteRole)}.`,
          url: inviteLink,
        })
        return
      }
      await navigator.clipboard?.writeText(inviteLink)
    } catch (error) {
      console.error(error)
    }
  }

  return (
    <div
      className="premium-backdrop fixed inset-0 z-50 flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`premium-modal glass-panel w-full max-w-[calc(100vw-1.5rem)] max-h-[82svh] overflow-x-hidden overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
          isMobilePortrait ? 'rounded-[1.5rem] sm:max-w-md' : 'max-w-2xl rounded-[1.8rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Collaborators</div>
            <h3 className="mt-1 text-[1.6rem] font-bold tracking-[-0.02em] text-slate-900">Share this trip</h3>
            <p className="mt-1 text-[13px] leading-6 text-slate-600">
              Invite people and choose what they can edit or view.
            </p>
          </div>
          <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {canManage ? (
          <div className="mt-5 space-y-3">
            <div className="rounded-[1.2rem] bg-slate-50/90 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
                <Field label="Google account email">
                  <input
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@example.com"
                    className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                  />
                </Field>
                <Field label="Access">
                  <select
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                    className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                  >
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Read-only</option>
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
              <p className="mt-3 text-[12px] leading-5 text-slate-500">
                {roleAccessDescription(role)}
              </p>
            </div>

            <div className="rounded-[1.2rem] bg-slate-50/90 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field label="Link access">
                  <select
                    value={inviteRole}
                    onChange={(event) => {
                      setInviteRole(event.target.value)
                      setInviteLink('')
                    }}
                    className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                  >
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Read-only</option>
                  </select>
                  <p className="mt-2 text-[12px] leading-5 text-slate-500">
                    {roleAccessDescription(inviteRole)}
                  </p>
                </Field>
                <button
                  type="button"
                  onClick={() => void handleCreateInvite()}
                  disabled={busy}
                  className="rounded-[1rem] bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:bg-slate-300"
                >
                  Create link
                </button>
              </div>
              {inviteLink ? (
                <div className="mt-3 flex flex-col gap-2 rounded-[1rem] bg-white p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1 truncate text-[12px] text-slate-600">{inviteLink}</div>
                  <button
                    type="button"
                    onClick={() => void handleCopyInvite()}
                    className="rounded-[0.8rem] bg-slate-100 px-3 py-2 text-[12px] font-semibold text-slate-700"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleShareInvite()}
                    className="rounded-[0.8rem] bg-slate-900 px-3 py-2 text-[12px] font-semibold text-white"
                  >
                    Share
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="mt-5 space-y-2.5">
          {members.map((member) => {
            const isCurrentUser = member.uid === currentUser?.uid
            const isOwner = member.role === 'owner'
            const canModifyMember = canManage && !isOwner && !isCurrentUser
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
                  {canModifyMember ? (
                    <div className="flex items-center gap-2">
                      <select
                        value={member.role}
                        onChange={(event) => void onUpdateRole(member, event.target.value)}
                        disabled={busy}
                        className="rounded-full border border-slate-200/90 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-700 disabled:bg-slate-100"
                      >
                        <option value="admin">Admin</option>
                        <option value="editor">Editor</option>
                        <option value="viewer">Read-only</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void onRemoveMember(member)}
                        disabled={busy}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600 disabled:bg-slate-100 disabled:text-slate-300"
                        aria-label={`Remove ${member.displayName || member.email || member.uid}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="rounded-full bg-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                      {roleLabel(member.role)}
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
  const effectiveNewDay = {
    ...newDay,
    date: newDay.date && !days.some((day) => day.date === newDay.date) ? newDay.date : nextDayDate(days),
  }

  async function handleAddDay() {
    const draft = { ...effectiveNewDay }
    await onAddDay(draft)
    setNewDay({
      date: nextDayDate([...days, { id: '__new__', date: draft.date, order: days.length }]),
      name: '',
    })
  }

  return (
    <div
      className="premium-backdrop fixed inset-0 z-50 flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`premium-modal glass-panel w-full max-w-[calc(100vw-1.5rem)] max-h-[82svh] overflow-x-hidden overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
          isMobilePortrait ? 'rounded-[1.55rem] sm:max-w-md' : 'max-w-3xl rounded-[1.8rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[1.7rem] font-bold tracking-[-0.02em] text-slate-900">Manage days</h3>
            <p className="mt-1 text-[13px] text-slate-600">
              Reorder, rename, edit dates, add, or delete trip days.
            </p>
            <p className="mt-2 max-w-md text-[12px] leading-5 text-slate-500">
              Reorder travel days or update their dates.
            </p>
          </div>
          <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          {days.map((day, index) => (
            <div
              key={day.id}
              className={`rounded-[1.3rem] bg-white p-4 shadow-[0_2px_10px_rgba(15,23,42,0.03)] ${
                day.id === activeDayId ? 'ring-2 ring-slate-300' : ''
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
                    aria-label={`Move ${buildDayLabel(day, index)} up`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-700 disabled:text-slate-300"
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveDay(day.id, 1)}
                    disabled={!firestoreReady || !canEdit || index === days.length - 1}
                    aria-label={`Move ${buildDayLabel(day, index)} down`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-700 disabled:text-slate-300"
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteDay(day.id)}
                    disabled={!firestoreReady || !canEdit}
                    aria-label={`Delete ${buildDayLabel(day, index)}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 disabled:text-slate-300"
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
                value={effectiveNewDay.date}
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
              onClick={() => void handleAddDay()}
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

function NoteModal({
  canEdit,
  item,
  isMobilePortrait,
  onAddSubstitute,
  onClose,
  onDelete,
  onDuplicate,
  onOpenDetails,
}) {
  const mapsUrl = item.category === 'Flight' ? '' : getGoogleMapsUrl(item)
  const locationSummary = itemLocationSummary(item)
  const canAddSubstitute = canEdit && !item.generated

  return (
    <div
      className="premium-backdrop fixed inset-0 z-50 flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`premium-modal glass-panel browse-ui w-full max-w-[calc(100vw-1.5rem)] max-h-[78svh] overflow-x-hidden overflow-y-auto border border-white/60 p-4 sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
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
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600"
                aria-label="Delete item"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-3.5 space-y-2">
          <div className="rounded-[1rem] bg-white px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Notes</div>
              {canEdit ? (
                <button
                  type="button"
                  onClick={onOpenDetails}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition hover:bg-slate-200"
                  aria-label="Edit notes"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <div className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-slate-700">
              {item.generated
                ? 'This hotel stop stays linked to the previous day hotel. You can still adjust time, notes, and booking details here.'
                : item.description || 'No notes added.'}
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
                  : 'No deadline added'}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-4">
          <div className="note-action-menu grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => void onAddSubstitute()}
              disabled={!canAddSubstitute}
              className="flex min-h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-[0.95rem] border border-slate-200/70 bg-white px-1.5 py-2 text-center text-[10px] font-semibold leading-3 tracking-[-0.01em] text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              aria-label="Add substitute item"
            >
              <Shuffle className="h-4 w-4" />
              <span>Substitute</span>
            </button>
            <button
              type="button"
              onClick={() => void onDuplicate()}
              disabled={!canEdit || item.generated}
              className="flex min-h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-[0.95rem] border border-slate-200/70 bg-white px-1.5 py-2 text-center text-[10px] font-semibold leading-3 tracking-[-0.01em] text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
              aria-label="Duplicate item"
            >
              <Copy className="h-4 w-4" />
              <span>Duplicate</span>
            </button>
            <button
              type="button"
              onClick={onOpenDetails}
              disabled={!canEdit}
              className="flex min-h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-[0.95rem] border border-slate-900 bg-slate-900 px-1.5 py-2 text-center text-[10px] font-bold leading-3 tracking-[-0.01em] text-white shadow-[0_10px_22px_rgba(15,23,42,0.10)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
              aria-label="Edit details"
            >
              <Pencil className="h-4 w-4" />
              <span>Edit</span>
            </button>
            {mapsUrl ? (
              <a
                href={mapsUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => onClose()}
                className="flex min-h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-[0.95rem] border border-slate-200/70 bg-white px-1.5 py-2 text-center text-[10px] font-semibold leading-3 tracking-[-0.01em] text-slate-700 transition hover:bg-slate-50"
                aria-label="Open in Google Maps"
              >
                <ExternalLink className="h-4 w-4" />
                <span>Maps</span>
              </a>
            ) : (
              <button
                type="button"
                disabled
                className="flex min-h-[4.25rem] flex-col items-center justify-center gap-1.5 rounded-[0.95rem] border border-slate-200/70 bg-slate-100 px-1.5 py-2 text-center text-[10px] font-semibold leading-3 tracking-[-0.01em] text-slate-400"
                aria-label="Open in Google Maps unavailable"
              >
                <ExternalLink className="h-4 w-4" />
                <span>Maps</span>
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-2 flex w-full items-center justify-center rounded-[0.95rem] bg-slate-100 px-4 py-3.5 text-sm font-semibold text-slate-600"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function AddStopComposer({
  activeDayId,
  canEdit,
  defaultParkingLot = false,
  dayMap,
  dayOptions,
  focusedDayId,
  firestoreReady,
  getFlightRecord,
  isMobilePortrait,
  mapsReady,
  onSaveNewItem,
}) {
  const defaultDayId =
    activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)
      ? activeDayId
      : focusedDayId && dayOptions.some((day) => day.id === focusedDayId)
        ? focusedDayId
        : dayOptions[0]?.id || ''
  const [draft, setDraft] = useState(() => ({
    ...buildEmptyDraft(defaultDayId),
    date: defaultParkingLot ? PARKING_LOT_DATE : '',
  }))
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const draftConflictId = '__draft__'
  const effectiveDraftDayId =
    activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)
      ? activeDayId
      : draft.dayId && dayOptions.some((day) => day.id === draft.dayId)
        ? draft.dayId
        : dayOptions[0]?.id || ''
  const isDraftParkingLotItem = draft.date === PARKING_LOT_DATE
  const draftFlightCode = draft.flightCode || extractFlightNumber(draft.title || '')
  const draftDayDate = dayMap[effectiveDraftDayId]?.date || ''
  const draftAppliedLookupKey = draft.flightInfo?.lookupKey || ''
  const draftFlightLookup = inferFlightLookupFromItem({
    ...draft,
    flightCode: draftFlightCode,
    dayDate: draftDayDate,
  })
  const draftLookupKey = buildFlightLookupKey(draftFlightLookup?.flightNumber, draftFlightLookup?.date)
  const canSaveDraft = draft.category === 'Flight'
    ? Boolean(draftFlightCode.trim())
    : Boolean((draft.title || '').trim())
  const draftScheduleConflict = useMemo(() => {
    if (isDraftParkingLotItem) return null
    if (!effectiveDraftDayId) return null
    const existingItems = dayMap[effectiveDraftDayId]?.items || []
    return getScheduleConflictMeta([
      ...existingItems,
      { ...draft, id: draftConflictId, dayId: effectiveDraftDayId },
    ])
  }, [dayMap, draft, effectiveDraftDayId, isDraftParkingLotItem])

  function getComposerDayId() {
    if (activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)) {
      return activeDayId
    }
    if (focusedDayId && dayOptions.some((day) => day.id === focusedDayId)) {
      return focusedDayId
    }
    if (draft.dayId && dayOptions.some((day) => day.id === draft.dayId)) {
      return draft.dayId
    }
    return dayOptions[0]?.id || ''
  }

  function buildComposerDraft(dayId = getComposerDayId()) {
    return {
      ...buildEmptyDraft(dayId),
      date: defaultParkingLot ? PARKING_LOT_DATE : '',
    }
  }

  function openAddComposer() {
    setDraft(buildComposerDraft())
    setIsComposerOpen(true)
  }

  function closeAddComposer() {
    setIsComposerOpen(false)
  }

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
    if (!firestoreReady || !effectiveDraftDayId || !canEdit || !canSaveDraft) return

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

    setDraft(buildComposerDraft())
    setIsComposerOpen(false)
  }

  return (
    <>
      {canEdit ? (
        <button
          type="button"
          onClick={openAddComposer}
          className="floating-add-button fixed bottom-[6.2rem] right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full border border-white/70 bg-slate-950 text-white shadow-[0_18px_42px_rgba(15,23,42,0.22)] transition hover:bg-slate-800 active:scale-95 sm:bottom-8 sm:right-8"
          aria-label="Add stop"
        >
          <Plus className="h-6 w-6" />
        </button>
      ) : null}

      {isComposerOpen && canEdit ? (
        <div
          className="premium-backdrop fixed inset-0 z-50 flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
          onClick={closeAddComposer}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className={`premium-modal glass-panel browse-ui w-full max-w-[calc(100vw-1.5rem)] max-h-[82svh] overflow-x-hidden overflow-y-auto border border-white/60 p-4 shadow-[0_24px_70px_rgba(15,23,42,0.18)] sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
              isMobilePortrait ? 'rounded-[1.35rem] sm:max-w-md' : 'max-w-xl rounded-[1.7rem]'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="headline text-[1.35rem] leading-none text-slate-950">Add stop</h3>
                <p className="mt-1 text-[12px] leading-5 text-slate-500">
                  {isDraftParkingLotItem
                    ? 'Add a stop to The Parking Lot.'
                    : dayMap[effectiveDraftDayId]?.date
                      ? `Add a stop to ${formatDayDate(dayMap[effectiveDraftDayId].date)}.`
                      : 'Add a stop to this trip.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeAddComposer}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600"
                aria-label="Close add stop form"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className={`mt-4 grid gap-3 ${isMobilePortrait ? '' : 'sm:grid-cols-2 sm:gap-3.5 sm:mt-5'}`}>
              <Field label="Day">
                <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-2">
                  <select
                    value={isDraftParkingLotItem ? '' : effectiveDraftDayId}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, dayId: event.target.value, date: '' }))
                    }
                    disabled={isDraftParkingLotItem}
                    className={`w-full rounded-[1.15rem] border px-4 py-3 text-sm ${
                      isDraftParkingLotItem
                        ? 'cursor-not-allowed border-slate-200/80 bg-slate-100 text-slate-400'
                        : 'border-slate-200/90 bg-white text-slate-900'
                    }`}
                  >
                    <option value="" aria-label="No day" />
                    {dayOptions.map((day) => (
                      <option key={day.id} value={day.id}>
                        {formatDayDate(day.date)}
                      </option>
                    ))}
                  </select>
                  <label
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-[1.15rem] border px-3 text-[12px] font-bold transition ${
                      isDraftParkingLotItem
                        ? 'border-slate-900 bg-slate-900 text-white shadow-[0_8px_18px_rgba(15,23,42,0.12)]'
                        : 'border-slate-200/90 bg-white text-slate-700 hover:border-slate-300'
                    } cursor-pointer`}
                  >
                    <input
                      type="checkbox"
                      checked={isDraftParkingLotItem}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          date: event.target.checked ? PARKING_LOT_DATE : '',
                        }))
                      }
                      className="sr-only"
                    />
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.35rem] border transition ${
                        isDraftParkingLotItem ? 'border-white bg-white text-slate-900' : 'border-slate-300 bg-slate-50'
                      }`}
                      aria-hidden="true"
                    >
                      {isDraftParkingLotItem ? <Check className="h-3 w-3 stroke-[3]" /> : null}
                    </span>
                    TBD
                  </label>
                </div>
                {isDraftParkingLotItem ? (
                  <p className="mt-2 text-[12px] leading-5 text-slate-500">
                    item will be moved to The Parking Lot.
                  </p>
                ) : null}
              </Field>
              <CategoryControl
                value={draft.category}
                onChange={(nextCategory) =>
                  setDraft((current) => {
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
                      endTime: current.endTimeMode === 'none' ? '' : current.endTime || '11:00',
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
              />
              <Field label={draft.category === 'Flight' ? 'Flight code' : 'Name'}>
                <input
                  value={draft.category === 'Flight' ? draftFlightCode : draft.title}
                  onChange={(event) =>
                    setDraft((current) =>
                      draft.category === 'Flight'
                        ? { ...current, flightCode: event.target.value.toUpperCase().replace(/\s+/g, '') }
                        : { ...current, title: event.target.value },
                    )
                  }
                  placeholder={draft.category === 'Flight' ? 'AB123' : ''}
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <StartTimeModeRow
                disabled={draft.category === 'Flight'}
                draft={draft}
                onChange={(changes) => setDraft((current) => applyItemDraftPatch(current, changes))}
                conflict={Boolean(draftScheduleConflict?.nextId === draftConflictId)}
                showModeToggle
              />
              <EndTimeModeField
                disabled={draft.category === 'Flight'}
                draft={draft}
                onChange={(changes) => setDraft((current) => applyItemDraftPatch(current, changes))}
                conflict={Boolean(draftScheduleConflict?.currentId === draftConflictId)}
                showModeToggle={false}
              />
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
              disabled={!firestoreReady || !effectiveDraftDayId || !canSaveDraft}
              className="mt-5 w-full rounded-[1.1rem] bg-slate-900 px-4 py-4 text-sm font-bold text-white disabled:bg-slate-300"
            >
              Save new itinerary detail
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function ParkingLotScreen({
  activeDayId,
  canEdit,
  dayMap,
  dayOptions,
  firestoreReady,
  focusedDayId,
  getFlightRecord,
  isMobilePortrait,
  items,
  mapsReady,
  onOpenDetails,
  onSaveNewItem,
}) {
  const cardPressProps = (cardItem) => ({
    role: 'button',
    tabIndex: 0,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
      }
    },
    onContextMenu: (event) => event.preventDefault(),
    onClick: (event) => event.preventDefault(),
    onPointerDown: (event) => onOpenDetails.startPress(event, cardItem),
    onPointerMove: onOpenDetails.movePress,
    onPointerUp: (event) => onOpenDetails.endPress(event, cardItem),
    onPointerCancel: onOpenDetails.cancelPress,
    onPointerLeave: onOpenDetails.cancelPress,
  })

  return (
    <div className={`browse-ui ${isMobilePortrait ? 'space-y-3' : 'mx-auto max-w-3xl space-y-3'}`}>
      <div className="px-1">
        <h2 className="headline text-[1.7rem] leading-none text-slate-950 sm:text-[2rem]">
          The Parking Lot
        </h2>
        <p className="mt-2 max-w-xl text-[13px] leading-6 text-slate-600">
          Park unscheduled ideas here until they have a day.
        </p>
      </div>

      <div className="space-y-2">
        {items.map((item) => {
          const meta = typeMeta(item.category)
          const CategoryIcon = CATEGORY_ICON_COMPONENTS[item.category] || CircleEllipsis
          const locationSummary = itemLocationSummary(item)
          const transitSummary = buildTransitSummary(item)
          return (
            <article
              key={item.id}
              className={`timeline-card ${meta.card} relative z-10 rounded-[1.55rem] transition hover:bg-white active:bg-white ${
                isMobilePortrait ? 'ml-3 px-3.5 py-3' : 'ml-3 px-3.5 py-3.5 sm:px-5 sm:py-4'
              }`}
              {...cardPressProps(item)}
            >
              <span
                className={`pointer-events-none absolute left-0 top-1/2 z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white shadow-[0_8px_18px_rgba(15,23,42,0.10)] ${meta.tone}`}
                aria-hidden="true"
              >
                <CategoryIcon className="h-3.5 w-3.5" />
              </span>
              <div className="relative z-10 min-w-0">
                <div className={`flex items-start justify-between ${isMobilePortrait ? 'gap-2' : 'gap-3'}`}>
                  <div className="min-w-0 flex-1">
                    <h3 className={`${isMobilePortrait ? 'line-clamp-2 leading-5' : 'leading-6'} text-[0.98rem] font-bold tracking-[-0.02em] text-slate-950`}>
                      {item.title}
                    </h3>
                    {locationSummary ? (
                      <p className="mt-0.5 truncate text-[12px] text-slate-500 sm:mt-1">
                        {locationSummary}
                      </p>
                    ) : null}
                  </div>
                </div>
                {item.address && item.address !== item.locationName ? (
                  <p className="mt-0.5 truncate text-[11px] text-slate-400 sm:mt-1">{item.address}</p>
                ) : null}
                {transitSummary ? (
                  <div className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                    <TrainFront className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{transitSummary}</span>
                  </div>
                ) : null}
                {item.description ? (
                  <p className={`line-clamp-2 text-[12px] text-slate-500 ${
                    isMobilePortrait ? 'mt-1 leading-5' : 'mt-1.5 leading-5 sm:mt-2 sm:leading-6'
                  }`}>
                    {item.description}
                  </p>
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
            </article>
          )
        })}
        {!items.length ? (
          <div className="rounded-[1.2rem] bg-white/85 px-4 py-8 text-center shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
            <div className="text-[14px] font-bold text-slate-900">No items yet</div>
          </div>
        ) : null}
      </div>
      <AddStopComposer
        activeDayId={activeDayId}
        canEdit={canEdit}
        dayMap={dayMap}
        dayOptions={dayOptions}
        defaultParkingLot
        focusedDayId={focusedDayId}
        firestoreReady={firestoreReady}
        getFlightRecord={getFlightRecord}
        isMobilePortrait={isMobilePortrait}
        mapsReady={mapsReady}
        onSaveNewItem={onSaveNewItem}
      />
    </div>
  )
}

function CancellationDeadlinesScreen({
  bookingOptions,
  canEdit,
  isMobilePortrait,
  items,
  onOpenDetails,
}) {
  const monitoredItems = sortedCancellationEntries(items, bookingOptions)
  const urgentCount = monitoredItems.filter((item) =>
    ['overdue', 'within_3_days'].includes(cancellationStateForItem(item)),
  ).length
  const missingDeadlineCount = monitoredItems.filter(
    (item) => cancellationStateForItem(item) === 'no_deadline',
  ).length
  const nextDeadline = monitoredItems.find((item) => item.cancellationDeadline)

  return (
    <div className={`browse-ui ${isMobilePortrait ? 'space-y-3' : 'mx-auto max-w-4xl space-y-4'}`}>
      <div className="px-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Cancellation deadlines
        </div>
        <h2 className="headline mt-2 text-[1.7rem] leading-none text-slate-950 sm:text-[2rem]">
          Cancellation tracker
        </h2>
        <p className="mt-2 max-w-xl text-[13px] leading-6 text-slate-600">
          Deadlines are sorted by date. Review overdue and upcoming windows first.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-[0.95rem] bg-white px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">Urgent</div>
          <div className={`mt-1 text-[1.25rem] font-bold leading-none ${urgentCount ? 'text-rose-700' : 'text-slate-900'}`}>
            {urgentCount}
          </div>
        </div>
        <div className="rounded-[0.95rem] bg-white px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">Missing</div>
          <div className="mt-1 text-[1.25rem] font-bold leading-none text-slate-900">
            {missingDeadlineCount}
          </div>
        </div>
        <div className="rounded-[0.95rem] bg-white px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.04)]">
          <div className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">Next</div>
          <div className="mt-1 truncate text-[12px] font-bold leading-5 text-slate-900">
            {nextDeadline ? formatBookingDateTime(nextDeadline.cancellationDeadline) : 'None'}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {monitoredItems.map((item) => {
          const meta = cancellationUrgencyMeta(item)
          const name = item.locationName || item.title
          const editableItem = item.isBookingOption
            ? items.find((candidate) => candidate.id === item.sourceItemId)
            : item
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
                      : 'No deadline added'}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pl-1 sm:justify-end sm:pl-0">
                  <div>
                    <div className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${meta.badge}`}>
                      {meta.label}
                    </div>
                    <div className="mt-1 text-[10px] font-medium text-slate-500 sm:text-right">{meta.note}</div>
                  </div>
                  {canEdit && editableItem ? (
                    <button
                      type="button"
                      onClick={() => onOpenDetails(editableItem)}
                      className="flex min-h-11 items-center rounded-full bg-white px-4 text-[11px] font-bold text-slate-700 shadow-[0_4px_12px_rgba(15,23,42,0.035)]"
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
            <div className="text-[14px] font-bold text-slate-900">No deadlines tracked</div>
            <div className="mx-auto mt-1 max-w-xs text-[12px] leading-5 text-slate-500">
              Add cancellation details to a hotel or restaurant booking to track it here.
            </div>
          </div>
        ) : null}
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
  const isParkingLotItem = detailItem.date === PARKING_LOT_DATE
  const selectedDayId =
    detailItem.dayId && dayOptions.some((day) => day.id === detailItem.dayId)
      ? detailItem.dayId
      : dayOptions[0]?.id || ''
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
  const TravelModeIcon = travelModeMeta?.icon

  return (
    <div
      className="premium-backdrop fixed inset-0 z-50 flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`premium-modal glass-panel w-full max-w-[calc(100vw-1.5rem)] max-h-[78svh] overflow-x-hidden overflow-y-auto border border-white/60 p-4 pb-0 sm:max-h-[calc(100svh-4rem)] sm:p-5 sm:pb-0 ${
          isMobilePortrait ? 'rounded-[1.35rem] sm:max-w-md' : 'max-w-xl rounded-[1.7rem]'
        }`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[1.45rem] font-bold tracking-[-0.025em] text-slate-900">{detailItem.title}</h3>
            <div className="mt-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <Check className="h-3.5 w-3.5" />
              {isGenerated ? 'Linked stay' : 'Editing itinerary item'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isGenerated && canEdit ? (
              <button
                type="button"
                onClick={() => void onDelete()}
                disabled={!firestoreReady}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-50 text-rose-600 disabled:bg-slate-100 disabled:text-slate-400"
                aria-label="Delete item"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {isGenerated ? (
          <div className="mt-4 rounded-[0.95rem] bg-slate-100/90 px-4 py-3 text-[13px] leading-6 text-slate-600">
            This stay continues from the previous night. You can still edit its time, notes, and booking reference.
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
            <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-2">
              <select
                value={isParkingLotItem ? '' : selectedDayId}
                onChange={(event) => onChange({ dayId: event.target.value, date: '' })}
                disabled={fieldReadOnly || linkedLocked || isParkingLotItem}
                className={`w-full rounded-[1.15rem] border px-4 py-3 text-sm ${
                  isParkingLotItem
                    ? 'cursor-not-allowed border-slate-200/80 bg-slate-100 text-slate-400'
                    : 'border-slate-200/90 bg-white text-slate-900 disabled:bg-slate-100'
                }`}
              >
                <option value="" aria-label="No day" />
                {dayOptions.map((day) => (
                  <option key={day.id} value={day.id}>
                    {formatDayDate(day.date)}
                  </option>
                ))}
              </select>
              <label
                className={`flex min-h-11 items-center justify-center gap-2 rounded-[1.15rem] border px-3 text-[12px] font-bold transition ${
                  isParkingLotItem
                    ? 'border-slate-900 bg-slate-900 text-white shadow-[0_8px_18px_rgba(15,23,42,0.12)]'
                    : 'border-slate-200/90 bg-white text-slate-700 hover:border-slate-300'
                } ${fieldReadOnly || linkedLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  checked={isParkingLotItem}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? { date: PARKING_LOT_DATE }
                        : { dayId: selectedDayId, date: '' },
                    )
                  }
                  disabled={fieldReadOnly || linkedLocked}
                  className="sr-only"
                />
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.35rem] border transition ${
                    isParkingLotItem ? 'border-white bg-white text-slate-900' : 'border-slate-300 bg-slate-50'
                  }`}
                  aria-hidden="true"
                >
                  {isParkingLotItem ? <Check className="h-3 w-3 stroke-[3]" /> : null}
                </span>
                TBD
              </label>
            </div>
            {isParkingLotItem ? (
              <p className="mt-2 text-[12px] leading-5 text-slate-500">
                item will be moved to The Parking Lot.
              </p>
            ) : null}
          </Field>
          <CategoryControl
            value={detailItem.category}
            disabled={fieldReadOnly || linkedLocked}
            onChange={(category) => onChange({ category })}
          />
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
              placeholder={detailItem.category === 'Flight' ? 'AB123' : ''}
              disabled={fieldReadOnly || linkedLocked}
              className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm disabled:bg-slate-100"
            />
          </Field>
          <StartTimeModeRow
            disabled={fieldReadOnly}
            draft={detailItem}
            onChange={onChange}
            conflict={Boolean(scheduleConflict?.nextId === detailItem.id)}
            showModeToggle
          />
          <EndTimeModeField
            disabled={fieldReadOnly}
            draft={detailItem}
            onChange={onChange}
            conflict={Boolean(scheduleConflict?.currentId === detailItem.id)}
            showModeToggle={false}
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

        <div className="sticky bottom-0 -mx-4 mt-4 flex items-center justify-end gap-2 border-t border-white/70 bg-white/90 p-4 backdrop-blur sm:-mx-5 sm:p-5">
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
  focusedDayId,
  firestoreReady,
  getFlightRecord,
  isMobilePortrait,
  mapsReady,
  onDragStart,
  onOpenDetails,
  onPromoteSubstitute,
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
      : focusedDayId && dayOptions.some((day) => day.id === focusedDayId)
        ? focusedDayId
        : dayOptions[0]?.id || ''
  const [draft, setDraft] = useState(() => buildEmptyDraft(defaultDayId))
  const [expandedStacks, setExpandedStacks] = useState({})
  const [stackLayoutRefreshKey, setStackLayoutRefreshKey] = useState(0)
  const promotingSubstituteIdRef = useRef('')
  const cardPressProps = (cardItem) => ({
    role: 'button',
    tabIndex: 0,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
      }
    },
    onContextMenu: (event) => event.preventDefault(),
    onClick: (event) => event.preventDefault(),
    onPointerDown: (event) => onOpenDetails.startPress(event, cardItem),
    onPointerMove: onOpenDetails.movePress,
    onPointerUp: (event) => onOpenDetails.endPress(event, cardItem),
    onPointerCancel: onOpenDetails.cancelPress,
    onPointerLeave: onOpenDetails.cancelPress,
  })
  const draftConflictId = '__draft__'
  const effectiveDraftDayId =
    activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)
      ? activeDayId
      : draft.dayId && dayOptions.some((day) => day.id === draft.dayId)
        ? draft.dayId
        : dayOptions[0]?.id || ''
  const isDraftParkingLotItem = draft.date === PARKING_LOT_DATE
  const [isComposerOpen, setIsComposerOpen] = useState(false)
  const draftFlightCode = draft.flightCode || extractFlightNumber(draft.title || '')
  const draftDayDate = dayMap[effectiveDraftDayId]?.date || ''
  const draftAppliedLookupKey = draft.flightInfo?.lookupKey || ''
  const draftFlightLookup = inferFlightLookupFromItem({
    ...draft,
    flightCode: draftFlightCode,
    dayDate: draftDayDate,
  })
  const draftLookupKey = buildFlightLookupKey(draftFlightLookup?.flightNumber, draftFlightLookup?.date)
  const canSaveDraft = draft.category === 'Flight'
    ? Boolean(draftFlightCode.trim())
    : Boolean((draft.title || '').trim())
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
    if (isDraftParkingLotItem) return null
    if (!effectiveDraftDayId) return null
    const existingItems = dayMap[effectiveDraftDayId]?.items || []
    return getScheduleConflictMeta([
      ...existingItems,
      { ...draft, id: draftConflictId, dayId: effectiveDraftDayId },
    ])
  }, [dayMap, draft, effectiveDraftDayId, isDraftParkingLotItem])

  function getComposerDayId() {
    if (activeDayId !== DAY_VIEW_ALL && dayOptions.some((day) => day.id === activeDayId)) {
      return activeDayId
    }
    if (focusedDayId && dayOptions.some((day) => day.id === focusedDayId)) {
      return focusedDayId
    }
    if (draft.dayId && dayOptions.some((day) => day.id === draft.dayId)) {
      return draft.dayId
    }
    return dayOptions[0]?.id || ''
  }

  function openAddComposer() {
    const nextDayId = getComposerDayId()
    setDraft(buildEmptyDraft(nextDayId))
    setIsComposerOpen(true)
  }

  function closeAddComposer() {
    setIsComposerOpen(false)
  }

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
    if (!firestoreReady || !effectiveDraftDayId || !canEdit || !canSaveDraft) return

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

    setDraft(buildEmptyDraft(getComposerDayId()))
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
          const CategoryIcon = CATEGORY_ICON_COMPONENTS[item.category] || CircleEllipsis
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
          const isSubstituteStack = entry.stackKind === 'substitute'
          const showCollapsedSubstituteStack = isSubstituteStack && !isExpandedStack && stackAlternatives.length > 0
          const stackChoiceLabel = isSubstituteStack
            ? 'substitute options'
            : item.category === 'Hotel'
              ? 'hotel options'
              : 'restaurant options'
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
          const stackExcessCount = item.generated || isSubstituteStack ? 0 : Math.max(0, stackHeldCount - 1)
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
          const showOptionsRow = (!isSubstituteStack && isStack) || linkedBookingMeta.isOverbooked
          const toggleStack = (event) => {
            event?.stopPropagation?.()
            setExpandedStacks((current) => ({
              ...current,
              [entry.id]: !current[entry.id],
            }))
          }
          const refreshStackLayout = () => {
            window.requestAnimationFrame(() => {
              setStackLayoutRefreshKey((current) => current + 1)
              window.requestAnimationFrame(() => {
                document.documentElement.getBoundingClientRect()
                window.dispatchEvent(new Event('resize'))
              })
            })
          }
          const collapseStack = (event) => {
            event?.stopPropagation?.()
            setExpandedStacks((current) => ({
              ...current,
              [entry.id]: false,
            }))
            refreshStackLayout()
          }
          const expandStack = (event) => {
            event?.stopPropagation?.()
            setExpandedStacks((current) => ({
              ...current,
              [entry.id]: true,
            }))
          }
          const promoteSubstitute = (event, stackItem) => {
            event?.stopPropagation?.()
            event?.preventDefault?.()
            if (!onPromoteSubstitute) return
            if (promotingSubstituteIdRef.current === stackItem.id) return
            promotingSubstituteIdRef.current = stackItem.id
            void onPromoteSubstitute(stackItem, entry.items)
              .then(() => {
                setExpandedStacks((current) => ({
                  ...current,
                  [entry.id]: false,
                }))
                refreshStackLayout()
              })
              .finally(() => {
                promotingSubstituteIdRef.current = ''
              })
          }
          const showBeforeSlot = Boolean(dragState && isManual)
          const showAfterSlot =
            Boolean(dragState && isManual) &&
            (!nextItem || nextItem.dayId !== item.dayId || nextItem.generated)
          const isDraggingItem = dragState?.itemId === item.id
          const RouteIcon = nextSegment ? routeIconForMode(nextSegment.mode) : null
          return (
            <div
              key={`${entry.id}-${isExpandedStack ? 'expanded' : 'collapsed'}-${stackLayoutRefreshKey}`}
              className={`itinerary-step grid ${
                isMobilePortrait
                  ? 'grid-cols-[2.7rem_1.25rem_minmax(0,1fr)] gap-x-1.5 gap-y-1.5'
                  : 'grid-cols-[3.25rem_1.55rem_minmax(0,1fr)] gap-x-2 gap-y-2 sm:grid-cols-[3.75rem_1.65rem_minmax(0,1fr)] sm:gap-x-3'
              }`}
            >
              {showDayDivider ? (
                <div
                  data-itinerary-day-id={item.dayId}
                  className={`col-span-full flex items-center gap-3 px-1 first:pt-0 ${isMobilePortrait ? 'py-2.5' : 'py-4'}`}
                >
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
                  className={`col-span-full block h-4 w-full rounded-full border border-dashed transition ${
                    dragState?.slot?.dayId === item.dayId && dragState?.slot?.index === manualIndex
                      ? 'border-slate-500 bg-slate-200/80'
                      : 'border-slate-300/80 bg-transparent'
                  }`}
                  aria-label={`Move before ${item.title}`}
                />
              ) : null}
              <div className="timeline-time pt-3 text-right">
                <div className="text-[13px] font-bold tracking-[-0.01em] text-slate-900">{item.startTime}</div>
                {item.endTime ? <div className="mt-0.5 text-[10px] font-medium tracking-[-0.01em] text-slate-400 sm:mt-1">{item.endTime}</div> : null}
              </div>
              <div className="timeline-rail timeline-rail--stop">
                <span className={`timeline-dot ${meta.tone}`}>{index + 1}</span>
              </div>
                <div
                  className="relative min-h-0 min-w-0 overflow-visible"
                >
              <article
                className={`timeline-card ${meta.card} relative z-10 rounded-[1.55rem] transition hover:bg-white active:bg-white ${
                  isMobilePortrait ? 'px-3.5 py-3' : 'px-3.5 py-3.5 sm:px-5 sm:py-4'
                } ${
                  isDraggingItem ? 'scale-[0.995] opacity-45 ring-2 ring-slate-300/70' : ''
                } ${showCollapsedSubstituteStack ? 'shadow-[0_26px_56px_rgba(17,24,39,0.11)]' : ''}`}
                {...cardPressProps(item)}
              >
                  <span
                    className={`pointer-events-none absolute left-0 top-1/2 z-20 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white shadow-[0_8px_18px_rgba(15,23,42,0.10)] ${meta.tone}`}
                    aria-hidden="true"
                  >
                    <CategoryIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="relative z-10 min-w-0">
                    <div className={`flex items-start justify-between ${isMobilePortrait ? 'gap-2' : 'gap-3'}`}>
                      <div className="min-w-0 flex-1">
                        <h3 className={`${isMobilePortrait ? 'line-clamp-2 leading-5' : 'leading-6'} text-[0.98rem] font-bold tracking-[-0.02em] text-slate-950`}>{item.title}</h3>
                        {locationSummary ? (
                          <p className="mt-0.5 truncate text-[12px] text-slate-500 sm:mt-1">{locationSummary}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.generated ? (
                          <div className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-600">
                            Linked
                          </div>
                        ) : canEdit ? (
                          <button
                            type="button"
                            onPointerDown={(event) => onDragStart(event, item)}
                            onClick={(event) => event.stopPropagation()}
                            data-drag-handle="true"
                            title="Drag to reorder"
                            className="inline-flex h-11 w-11 touch-none shrink-0 items-center justify-center text-slate-500 transition hover:text-slate-800 active:scale-95"
                            aria-label={`Reorder ${item.title}`}
                          >
                            <ArrowUpDown className="h-4 w-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {item.address && item.address !== item.locationName ? (
                      <p className="mt-0.5 truncate text-[11px] text-slate-400 sm:mt-1">{item.address}</p>
                    ) : null}
                    {transitSummary ? (
                      <div className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                        <TrainFront className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{transitSummary}</span>
                      </div>
                    ) : null}
                    {(item.description || item.generated) ? (
                      <p className={`line-clamp-2 text-[12px] text-slate-500 ${
                        isMobilePortrait ? 'mt-1 leading-5' : 'mt-1.5 leading-5 sm:mt-2 sm:leading-6'
                      }`}>
                        {item.generated ? 'Continued from the previous night’s stay.' : item.description}
                      </p>
                    ) : null}
                    {showOptionsRow && (!isSubstituteStack || !isExpandedStack) ? (
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
                          {!isSubstituteStack ? (
                            <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
                              {comparisonCount} overlapping {stackChoiceLabel}
                            </span>
                          ) : null}
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
              </article>
                  {showCollapsedSubstituteStack ? (
                    <div className="relative z-0 -mt-[5px] pl-3 pb-1">
                      {stackAlternatives.slice(0, SUBSTITUTE_STACK_VISIBLE_DEPTH - 1).map((stackItem, stackIndex) => {
                        const depth = Math.min(stackIndex + 1, SUBSTITUTE_STACK_OFFSETS.length - 1)
                        const layer = SUBSTITUTE_STACK_OFFSETS[depth]
                        return (
                          <button
                            type="button"
                            key={`collapsed-summary-${stackItem.id}`}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                expandStack(event)
                              }
                            }}
                            onClick={expandStack}
                            className="relative flex h-9 w-full items-center justify-between gap-3 rounded-[1rem] border border-slate-200/80 bg-white/95 px-3.5 text-left text-[11px] font-semibold text-slate-600 shadow-[0_12px_26px_rgba(17,24,39,0.055)] transition hover:border-slate-300 hover:bg-white active:scale-[0.995]"
                            style={{
                              marginTop: stackIndex === 0 ? 0 : -5,
                              opacity: layer.opacity,
                              touchAction: 'pan-y',
                              transform: `translateY(${layer.y}px)`,
                              zIndex: SUBSTITUTE_STACK_VISIBLE_DEPTH - stackIndex,
                            }}
                            aria-label={`Open substitute option ${stackItem.title}`}
                          >
                            <span className="min-w-0 truncate">{stackItem.title}</span>
                            <span className="shrink-0 text-[10px] font-bold text-slate-400">
                              {stackItem.startTime}
                              {stackItem.endTime ? `-${stackItem.endTime}` : ''}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                  {isSubstituteStack && isExpandedStack && isStack ? (
                    <div className="mt-0.5 max-h-[56svh] space-y-1 overflow-y-auto py-0 pr-1 pl-3 sm:space-y-1.5">
                      <div className="flex h-7 justify-end">
                        <button
                          type="button"
                          onClick={collapseStack}
                          aria-label="Collapse substitute options"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200/80 bg-white text-slate-500 shadow-[0_6px_14px_rgba(17,24,39,0.055)] transition hover:border-slate-300 hover:text-slate-900 active:scale-95"
                        >
                          <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                        </button>
                      </div>
                      {stackAlternatives.map((stackItem) => {
                        const stackMeta = typeMeta(stackItem.category)
                        const StackCategoryIcon = CATEGORY_ICON_COMPONENTS[stackItem.category] || CircleEllipsis
                        const stackHasActive = hasActiveSelectionStatus(stackItem)
                        return (
                          <article
                            key={stackItem.id}
                            className={`timeline-card ${stackMeta.card} relative rounded-[1.25rem] px-3.5 py-3 transition hover:bg-white sm:px-4 sm:py-3.5`}
                            style={{
                              borderLeftColor: stackHasActive ? '#10b981' : '#94a3b8',
                            }}
                            {...cardPressProps(stackItem)}
                          >
                            <span
                              className={`pointer-events-none absolute left-0 top-1/2 z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white shadow-[0_8px_18px_rgba(15,23,42,0.10)] ${stackMeta.tone}`}
                              aria-hidden="true"
                            >
                              <StackCategoryIcon className="h-3 w-3" />
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <h4 className={`${isMobilePortrait ? 'line-clamp-2 leading-5' : 'leading-5'} text-[0.92rem] font-bold tracking-[-0.02em] text-slate-950`}>
                                    {stackItem.title}
                                  </h4>
                                  {stackItem.locationName ? (
                                    <p className="mt-0.5 truncate text-[12px] text-slate-500 sm:mt-1">{stackItem.locationName}</p>
                                  ) : null}
                                </div>
                                {stackHasActive ? (
                                  <div className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700">
                                    Active
                                  </div>
                                ) : canEdit ? (
                                  <button
                                    type="button"
                                    onPointerDown={(event) => {
                                      event.stopPropagation()
                                    }}
                                    onPointerUp={(event) => event.stopPropagation()}
                                    onKeyDown={(event) => {
                                      event.stopPropagation()
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        promoteSubstitute(event, stackItem)
                                      }
                                    }}
                                    onClick={(event) => promoteSubstitute(event, stackItem)}
                                    aria-label={`Make ${stackItem.title} the primary choice`}
                                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-200/80 bg-white text-slate-500 shadow-[0_6px_14px_rgba(17,24,39,0.055)] transition hover:border-blue-200 hover:bg-blue-50 hover:text-[#2F6BFF] active:scale-95"
                                  >
                                    <Star className="h-3.5 w-3.5" />
                                  </button>
                                ) : null}
                              </div>
                              {stackItem.address && stackItem.address !== stackItem.locationName ? (
                                <p className="mt-2 truncate text-[11px] text-slate-400">{stackItem.address}</p>
                              ) : null}
                              {stackItem.description ? (
                                <p className="mt-2 line-clamp-2 text-[12px] leading-6 text-slate-500">
                                  {stackItem.description}
                                </p>
                              ) : null}
                              <div className="mt-2 rounded-[0.75rem] bg-slate-50 px-3 py-1.5 text-[11px] leading-5 text-slate-600">
                                <span className="font-semibold text-slate-800">
                                  {stackItem.startTime}
                                  {stackItem.endTime ? `-${stackItem.endTime}` : ''}
                                </span>
                                {stackItem.cancellationDeadline ? (
                                  <span className="block">
                                    Deadline {formatBookingDateTime(stackItem.cancellationDeadline)}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                  ) : null}
                </div>

              {isExpandedStack && isStack && !isSubstituteStack ? (
                  <div className="relative col-start-3 space-y-1.5 overflow-visible sm:space-y-2.5">
                  {stackAlternatives.map((stackItem, stackIndex) => {
                    const stackMeta = typeMeta(stackItem.category)
                    const stackHasActive = hasActiveStayOrMealStatus(stackItem)
                    return (
                      <article
                        key={stackItem.id}
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
                        {...cardPressProps(stackItem)}
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
                <div className="col-start-3 space-y-1.5 overflow-visible sm:space-y-2">
                  {itemBookingOptions.map((booking) => {
                    const bookingDeadline = booking.cancellationDeadline
                      ? formatBookingDateTime(booking.cancellationDeadline)
                      : 'No deadline added'
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
                <>
                  <div className="timeline-time py-1 text-right">
                    {item.endTime ? (
                      <div className="text-[11px] font-semibold tracking-[-0.01em] text-slate-500">{item.endTime}</div>
                    ) : null}
                  </div>
                  <div className="timeline-rail timeline-rail--route">
                    <span className="timeline-route-dot" />
                  </div>
                  <div className="timeline-route-row flex items-center justify-between gap-3 rounded-[0.9rem] px-2 py-0 text-slate-500 sm:px-3">
                    <div className="flex min-w-0 items-center gap-2.5" aria-label={`${routeLabel(nextSegment.mode)} ${routeDurationText(nextSegment)}`}>
                      {RouteIcon ? <RouteIcon className="h-4 w-4 shrink-0 text-slate-400" /> : null}
                      <span className="truncate text-[13px] font-bold tracking-[-0.02em] text-slate-500">
                        {routeDurationText(nextSegment)}
                      </span>
                    </div>
                    {canEdit ? (
                      <RouteModeControl
                        currentMode={nextSegment.from.travelModeToNext || ''}
                        onSelect={(mode) => onUpdateTravelMode(nextSegment.from.id, mode)}
                      />
                    ) : null}
                  </div>
                </>
              ) : null}
              {showAfterSlot ? (
                <button
                  type="button"
                  data-drop-slot-day-id={item.dayId}
                  data-drop-slot-index={(manualOrderLookup.counts[item.dayId] || 0)}
                  className={`col-span-full block h-4 w-full rounded-full border border-dashed transition ${
                    dragState?.slot?.dayId === item.dayId &&
                    dragState?.slot?.index === (manualOrderLookup.counts[item.dayId] || 0)
                      ? 'border-slate-500 bg-slate-200/80'
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
                ? 'border-slate-500 bg-slate-200/80 text-slate-800'
                : 'border-slate-300/80 text-slate-500'
            }`}
          >
            Move stop here
          </button>
        ) : null}
      </div>

      {canEdit ? (
        <button
          type="button"
          onClick={openAddComposer}
          className="floating-add-button fixed bottom-[6.2rem] right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full border border-white/70 bg-slate-950 text-white shadow-[0_18px_42px_rgba(15,23,42,0.22)] transition hover:bg-slate-800 active:scale-95 sm:bottom-8 sm:right-8"
          aria-label="Add stop"
        >
          <Plus className="h-6 w-6" />
        </button>
      ) : null}

      {isComposerOpen && canEdit ? (
        <div
          className="premium-backdrop fixed inset-0 z-50 flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 sm:items-center sm:justify-center sm:p-4"
          onClick={closeAddComposer}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className={`premium-modal glass-panel browse-ui w-full max-w-[calc(100vw-1.5rem)] max-h-[82svh] overflow-x-hidden overflow-y-auto border border-white/60 p-4 shadow-[0_24px_70px_rgba(15,23,42,0.18)] sm:max-h-[calc(100svh-4rem)] sm:p-5 ${
              isMobilePortrait ? 'rounded-[1.35rem] sm:max-w-md' : 'max-w-xl rounded-[1.7rem]'
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="headline text-[1.35rem] leading-none text-slate-950">Add stop</h3>
                <p className="mt-1 text-[12px] leading-5 text-slate-500">
                  {isDraftParkingLotItem
                    ? 'Add a stop to The Parking Lot.'
                    : dayMap[effectiveDraftDayId]?.date
                    ? `Add a stop to ${formatDayDate(dayMap[effectiveDraftDayId].date)}.`
                    : 'Add a stop to this trip.'}
                </p>
              </div>
              <button
                type="button"
                onClick={closeAddComposer}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600"
                aria-label="Close add stop form"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className={`mt-4 grid gap-3 ${isMobilePortrait ? '' : 'sm:grid-cols-2 sm:gap-3.5 sm:mt-5'}`}>
              <Field label="Day">
                <div className="grid grid-cols-[minmax(0,1fr)_5.75rem] gap-2">
                  <select
                    value={isDraftParkingLotItem ? '' : effectiveDraftDayId}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, dayId: event.target.value, date: '' }))
                    }
                    disabled={isDraftParkingLotItem}
                    className={`w-full rounded-[1.15rem] border px-4 py-3 text-sm ${
                      isDraftParkingLotItem
                        ? 'cursor-not-allowed border-slate-200/80 bg-slate-100 text-slate-400'
                        : 'border-slate-200/90 bg-white text-slate-900'
                    }`}
                  >
                    <option value="" aria-label="No day" />
                    {dayOptions.map((day) => (
                      <option key={day.id} value={day.id}>
                        {formatDayDate(day.date)}
                      </option>
                    ))}
                  </select>
                  <label
                    className={`flex min-h-11 items-center justify-center gap-2 rounded-[1.15rem] border px-3 text-[12px] font-bold transition ${
                      isDraftParkingLotItem
                        ? 'border-slate-900 bg-slate-900 text-white shadow-[0_8px_18px_rgba(15,23,42,0.12)]'
                        : 'border-slate-200/90 bg-white text-slate-700 hover:border-slate-300'
                    } cursor-pointer`}
                  >
                    <input
                      type="checkbox"
                      checked={isDraftParkingLotItem}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          date: event.target.checked ? PARKING_LOT_DATE : '',
                        }))
                      }
                      className="sr-only"
                    />
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.35rem] border transition ${
                        isDraftParkingLotItem ? 'border-white bg-white text-slate-900' : 'border-slate-300 bg-slate-50'
                      }`}
                      aria-hidden="true"
                    >
                      {isDraftParkingLotItem ? <Check className="h-3 w-3 stroke-[3]" /> : null}
                    </span>
                    TBD
                  </label>
                </div>
                {isDraftParkingLotItem ? (
                  <p className="mt-2 text-[12px] leading-5 text-slate-500">
                    item will be moved to The Parking Lot.
                  </p>
                ) : null}
              </Field>
              <CategoryControl
                value={draft.category}
                onChange={(nextCategory) =>
                  setDraft((current) => {
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
                      endTime: current.endTimeMode === 'none' ? '' : current.endTime || '11:00',
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
              />
              <Field label={draft.category === 'Flight' ? 'Flight code' : 'Name'}>
                <input
                  value={draft.category === 'Flight' ? draftFlightCode : draft.title}
                  onChange={(event) =>
                    setDraft((current) =>
                      draft.category === 'Flight'
                        ? { ...current, flightCode: event.target.value.toUpperCase().replace(/\s+/g, '') }
                        : { ...current, title: event.target.value },
                    )
                  }
                  placeholder={draft.category === 'Flight' ? 'AB123' : ''}
                  className="w-full rounded-[1.15rem] border border-slate-200/90 bg-white px-4 py-3 text-sm"
                />
              </Field>
              <StartTimeModeRow
                disabled={draft.category === 'Flight'}
                draft={draft}
                onChange={(changes) => setDraft((current) => applyItemDraftPatch(current, changes))}
                conflict={Boolean(draftScheduleConflict?.nextId === draftConflictId)}
                showModeToggle
              />
              <EndTimeModeField
                disabled={draft.category === 'Flight'}
                draft={draft}
                onChange={(changes) => setDraft((current) => applyItemDraftPatch(current, changes))}
                conflict={Boolean(draftScheduleConflict?.currentId === draftConflictId)}
                showModeToggle={false}
              />
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
              disabled={!firestoreReady || !effectiveDraftDayId || !canSaveDraft}
              className="mt-5 w-full rounded-[1.1rem] bg-slate-900 px-4 py-4 text-sm font-bold text-white disabled:bg-slate-300"
            >
              Save new itinerary detail
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function MapPanel({
  activeDayId,
  fallbackLocationLabel,
  filteredItems,
  isMobilePortrait,
  mapsReady,
  mapsError,
  routeSegments,
}) {
  const mapItems = useMemo(() => buildMapItems(filteredItems), [filteredItems])
  const hasMapItems = mapItems.some((item) => typeof item.lat === 'number' && typeof item.lng === 'number')

  return (
    <div className="browse-ui">
      <div className="glass-panel rounded-[1.15rem] px-3.5 py-3.5 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="headline text-[1.35rem] leading-none text-slate-950">Map</h2>
            <p className="mt-1 text-[13px] text-slate-500">
              {!hasMapItems && fallbackLocationLabel
                ? `Starting map: ${fallbackLocationLabel}`
                : activeDayId === DAY_VIEW_ALL
                  ? 'Whole trip view'
                  : 'Selected day route'}
            </p>
          </div>
        </div>

        <div
          className={`mt-3.5 overflow-hidden rounded-[1rem] border border-slate-100 bg-slate-50 sm:mt-4 ${
            isMobilePortrait ? 'h-[240px]' : 'h-[320px]'
          }`}
        >
          {mapsReady ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center bg-slate-50 text-sm font-medium text-slate-500">
                  Loading map...
                </div>
              }
            >
              <TripMap
                fallbackLocationLabel={fallbackLocationLabel}
                filteredItems={mapItems}
                routeSegments={routeSegments}
              />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center bg-slate-50 px-6 text-center text-sm font-medium text-slate-500">
              {mapsError || 'Map preview is not available yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const MemoMapPanel = memo(MapPanel)

function AppDialog({ dialog, onCancel, onSubmit }) {
  const inputRef = useRef(null)
  const tripNameRef = useRef(null)
  const tripStartDateRef = useRef(null)
  const tripEndDateRef = useRef(null)
  const tripCityRef = useRef(null)

  if (!dialog) return null

  const isPrompt = dialog.type === 'prompt'
  const isChoice = dialog.type === 'choice'
  const isTripSetup = dialog.type === 'tripSetup'
  const isDanger = dialog.tone === 'danger'
  const defaultTripSetup = dialog.defaultValue || {}

  return (
    <div
      className="premium-backdrop fixed inset-0 z-[90] flex items-end overflow-x-hidden bg-slate-950/40 p-3 pt-10 backdrop-blur-[2px] sm:items-center sm:justify-center sm:p-4"
      onClick={onCancel}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (isTripSetup) {
            onSubmit({
              title: tripNameRef.current?.value.trim() || '',
              startDate: tripStartDateRef.current?.value || '',
              endDate: tripEndDateRef.current?.value || '',
              city: normalizeTripCity(tripCityRef.current?.value || ''),
            })
            return
          }
          onSubmit(isChoice ? null : isPrompt ? inputRef.current?.value.trim() || '' : true)
        }}
        onClick={(event) => event.stopPropagation()}
        className="premium-modal glass-panel w-full max-w-[min(28rem,calc(100vw-1.5rem))] overflow-x-hidden rounded-[1.35rem] border border-white/70 p-4 shadow-[0_22px_60px_rgba(15,23,42,0.18)] sm:rounded-[1.55rem] sm:p-5"
      >
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              isDanger ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-700'
            }`}
          >
            {isDanger ? (
              <Trash2 className="h-4 w-4" />
            ) : isTripSetup ? (
              <CalendarDays className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-[1.05rem] font-bold leading-6 tracking-[-0.02em] text-slate-950">
              {dialog.title}
            </h2>
            {dialog.message ? (
              <p className="mt-1 text-[13px] leading-5 text-slate-600">{dialog.message}</p>
            ) : null}
          </div>
        </div>

        {isPrompt ? (
          <input
            key={`${dialog.title}-${dialog.defaultValue || ''}`}
            ref={inputRef}
            autoFocus
            defaultValue={dialog.defaultValue || ''}
            className="mt-4 w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm font-medium text-slate-900"
          />
        ) : null}

        {isTripSetup ? (
          <div className="mt-4 space-y-3">
            <Field label="Trip name">
              <input
                ref={tripNameRef}
                autoFocus
                required
                defaultValue={defaultTripSetup.title || ''}
                className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm font-medium text-slate-900"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Start date">
                <input
                  ref={tripStartDateRef}
                  type="date"
                  required
                  defaultValue={defaultTripSetup.startDate || localTodayIso()}
                  className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm font-medium text-slate-900"
                />
              </Field>
              <Field label="End date">
                <input
                  ref={tripEndDateRef}
                  type="date"
                  required
                  defaultValue={defaultTripSetup.endDate || defaultTripSetup.startDate || localTodayIso()}
                  className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm font-medium text-slate-900"
                />
              </Field>
            </div>
            <Field label="City">
              <input
                ref={tripCityRef}
                required
                defaultValue={defaultTripSetup.city || ''}
                placeholder="Tokyo, Japan"
                className="w-full rounded-[1rem] border border-slate-200/90 bg-white px-4 py-3 text-sm font-medium text-slate-900"
              />
            </Field>
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          {isChoice ? (
            dialog.choices.map((choice) => (
              <button
                key={choice.value}
                type="button"
                onClick={() => onSubmit(choice.value)}
                className={`rounded-[0.9rem] px-4 py-2.5 text-[13px] font-bold ${
                  choice.tone === 'danger'
                    ? 'bg-rose-600 text-white'
                    : choice.variant === 'primary'
                      ? 'bg-slate-950 text-white'
                      : 'border border-slate-200 bg-white text-slate-700'
                }`}
              >
                {choice.label}
              </button>
            ))
          ) : dialog.type !== 'alert' ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-[0.9rem] border border-slate-200 bg-white px-4 py-2.5 text-[13px] font-semibold text-slate-700"
            >
              {dialog.cancelLabel || 'Cancel'}
            </button>
          ) : null}
          {!isChoice ? (
            <button
              type="submit"
              className={`rounded-[0.9rem] px-4 py-2.5 text-[13px] font-bold text-white ${
                isDanger ? 'bg-rose-600' : 'bg-slate-950'
              }`}
            >
              {dialog.confirmLabel || 'OK'}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  )
}

export default function App() {
  const googleMapsState = useGoogleMapsApi(MAPS_API_KEY)
  const [activeDayId, setActiveDayId] = useState(DAY_VIEW_ALL)
  const [focusedOverviewDayId, setFocusedOverviewDayId] = useState('')
  const [activeTripId, setActiveTripId] = useState(() => {
    if (typeof window === 'undefined') return TRIP_ID
    return window.localStorage.getItem(ACTIVE_TRIP_STORAGE_KEY) || TRIP_ID
  })
  const [overrides, setOverrides] = useState(() =>
    firebaseEnabled ? { days: {}, items: {}, bookingOptions: {} } : readLocalTripOverrides(),
  )
  const [tripSummaries, setTripSummaries] = useState(() =>
    firebaseEnabled ? [] : buildLocalTripSummaries(readLocalTripOverrides()),
  )
  const [tripDirectoryLoaded, setTripDirectoryLoaded] = useState(!firebaseEnabled)
  const [currentUser, setCurrentUser] = useState(null)
  const [authReady, setAuthReady] = useState(!firebaseEnabled)
  const [authError, setAuthError] = useState('')
  const [firestoreState, setFirestoreState] = useState({
    status: firebaseEnabled ? 'ready' : 'disabled',
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
  const [showParkingLot, setShowParkingLot] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showPdfExportOptions, setShowPdfExportOptions] = useState(false)
  const [pdfExporting, setPdfExporting] = useState(false)
  const [dragState, setDragState] = useState(null)
  const [tripMembers, setTripMembers] = useState([])
  const [appDialog, setAppDialog] = useState(null)
  const [pendingInviteId, setPendingInviteId] = useState(readInviteIdFromUrl)

  const isMobilePortrait = useResponsiveMode()
  const routeCacheRef = useRef(new Map())
  const flightLookupCacheRef = useRef(new Map())
  const dragDaySwitchRef = useRef(null)
  const dragAutoScrollFrameRef = useRef(null)
  const dragPointerRef = useRef({ x: 0, y: 0 })
  const dragStateRef = useRef(null)
  const guestMigrationRef = useRef({
    declinedForUid: '',
    inProgress: false,
    localOverrides: null,
    localTitle: '',
    promptedForUid: '',
  })
  const inviteAcceptanceRef = useRef({
    inProgress: false,
    promptedForId: '',
  })
  const appDialogResolveRef = useRef(null)
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
  const isSignedIn = Boolean(currentUser?.uid)
  const isGuestMode = !isSignedIn
  const effectiveUser = currentUser || GUEST_USER
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

  const tripState = useMemo(
    () => deriveTripState(overrides, { includeSeed: false }),
    [overrides],
  )
  const activeTripSummary = availableTrips.find((trip) => trip.id === resolvedTripId) || null
  const activeRole = activeTripSummary?.role || ''
  const canEditCurrentTrip = canEditTrip(activeRole)
  const canManageCurrentTrip = canManageMembers(activeRole, activeTripSummary, currentUser)
  const canDeleteCurrentTrip = isGuestMode
    ? activeRole === 'owner'
    : canDeleteTrip(activeRole, activeTripSummary, currentUser)
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
  const navFocusedDayId =
    resolvedActiveDayId === DAY_VIEW_ALL ? focusedOverviewDayId || dayOptions[0]?.id || '' : ''

  useEffect(() => {
    if (resolvedActiveDayId !== DAY_VIEW_ALL || !dayOptions.length) {
      queueMicrotask(() => setFocusedOverviewDayId(''))
      return undefined
    }

    let frame = 0
    const fallbackDayId = dayOptions[0]?.id || ''

    const updateFocusedDay = () => {
      frame = 0
      const markers = [...document.querySelectorAll('[data-itinerary-day-id]')]
      if (!markers.length) {
        setFocusedOverviewDayId(fallbackDayId)
        return
      }

      const focusLine = Math.min(window.innerHeight * 0.34, 260)
      let nextDayId = markers[0].getAttribute('data-itinerary-day-id') || fallbackDayId

      markers.some((marker) => {
        const markerTop = marker.getBoundingClientRect().top
        if (markerTop > focusLine) return true
        nextDayId = marker.getAttribute('data-itinerary-day-id') || nextDayId
        return false
      })

      setFocusedOverviewDayId((current) => (current === nextDayId ? current : nextDayId))
    }

    const scheduleUpdate = () => {
      if (frame) return
      frame = window.requestAnimationFrame(updateFocusedDay)
    }

    scheduleUpdate()
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
    }
  }, [dayOptions, filteredItems, resolvedActiveDayId])

  const closeAppDialog = useCallback((result) => {
    const resolve = appDialogResolveRef.current
    appDialogResolveRef.current = null
    setAppDialog(null)
    resolve?.(result)
  }, [])

  const openAppDialog = useCallback((dialog) => {
    if (appDialogResolveRef.current) {
      appDialogResolveRef.current(null)
    }

    return new Promise((resolve) => {
      appDialogResolveRef.current = resolve
      setAppDialog(dialog)
    })
  }, [])

  const showAlert = useCallback(
    (message, options = {}) =>
      openAppDialog({
        type: 'alert',
        title: options.title || 'Notice',
        message,
        confirmLabel: options.confirmLabel || 'OK',
        tone: options.tone || 'default',
      }),
    [openAppDialog],
  )

  const showConfirm = useCallback(
    (message, options = {}) =>
      openAppDialog({
        type: 'confirm',
        title: options.title || 'Confirm action',
        message,
        confirmLabel: options.confirmLabel || 'Confirm',
        cancelLabel: options.cancelLabel || 'Cancel',
        tone: options.tone || 'default',
      }),
    [openAppDialog],
  )

  const showChoice = useCallback(
    (message, options = {}) =>
      openAppDialog({
        type: 'choice',
        title: options.title || 'Choose an action',
        message,
        choices: options.choices || [],
        tone: options.tone || 'default',
      }),
    [openAppDialog],
  )

  const showPrompt = useCallback(
    (message, options = {}) =>
      openAppDialog({
        type: 'prompt',
        title: options.title || message,
        message: options.title ? message : '',
        defaultValue: options.defaultValue || '',
        confirmLabel: options.confirmLabel || 'Save',
        cancelLabel: options.cancelLabel || 'Cancel',
        tone: options.tone || 'default',
      }),
    [openAppDialog],
  )

  const showTripSetup = useCallback(
    (options = {}) =>
      openAppDialog({
        type: 'tripSetup',
        title: options.title || 'Create trip',
        message: options.message || 'Set the basic details for this itinerary.',
        defaultValue: options.defaultValue || {},
        confirmLabel: options.confirmLabel || 'Create trip',
        cancelLabel: options.cancelLabel || 'Cancel',
        tone: options.tone || 'default',
      }),
    [openAppDialog],
  )

  const weatherTarget = useMemo(
    () => getWeatherTargetForDay(resolvedActiveDayId, tripState),
    [resolvedActiveDayId, tripState],
  )
  const weatherTargetKey = weatherTarget
    ? `${weatherTarget.date}|${weatherTarget.lat.toFixed(4)},${weatherTarget.lng.toFixed(4)}`
    : ''
  const selectedWeather =
    resolvedActiveDayId === DAY_VIEW_ALL || weatherState.targetKey !== weatherTargetKey
      ? null
      : (weatherState.data?.dailyByDate?.[tripState.dayMap[resolvedActiveDayId]?.date || ''] ??
        weatherState.data?.historicalByDate?.[tripState.dayMap[resolvedActiveDayId]?.date || ''] ??
        null)
  const effectiveWeatherState = weatherTarget
    ? {
        ...weatherState,
        loading: weatherState.targetKey !== weatherTargetKey,
      }
    : { loading: false, data: null, error: '' }
  const firestoreReady =
    isGuestMode || (firebaseEnabled && authReady && isSignedIn && firestoreState.status === 'ready')
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
    if (detailItem.date === PARKING_LOT_DATE) return null
    const existingItems = (tripState.dayMap[detailItem.dayId]?.items || []).filter(
      (item) => item.id !== detailItem.id,
    )
    return getScheduleConflictMeta([...existingItems, detailItem])
  }, [detailItem, tripState.dayMap])
  const detailEndTimeWarning = useMemo(() => getEndTimeWarning(detailItem), [detailItem])
  const urgentDeadlineCount = useMemo(
    () =>
      sortedCancellationEntries(tripState.items, tripState.bookingOptions).filter((entry) =>
        ['overdue', 'within_3_days'].includes(cancellationStateForItem(entry)),
      ).length,
    [tripState.bookingOptions, tripState.items],
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

  const saveTripPatch = useCallback(async (tripId, patch) => {
    if (isGuestMode) {
      setOverrides((current) => mergeTripOverrides(current, patch))
      setFirestoreState({ status: 'ready', error: '' })
      return
    }

    await mergeTripPatch(tripId, patch)
  }, [isGuestMode])

  const clearInviteUrl = useCallback(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    url.searchParams.delete('invite')
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (resolvedTripId) {
      window.localStorage.setItem(ACTIVE_TRIP_STORAGE_KEY, resolvedTripId)
    }
  }, [resolvedTripId])

  useEffect(() => {
    if (!isGuestMode || !authReady || typeof window === 'undefined') return
    if (firebaseEnabled && !hasTripOverrides(overrides)) return
    window.localStorage.setItem(LOCAL_TRIP_OVERRIDES_KEY, JSON.stringify(overrides))
  }, [authReady, isGuestMode, overrides])

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
        const localOverrides = readLocalTripOverrides()
        setCurrentUser(null)
        setAuthReady(true)
        setTripSummaries(buildLocalTripSummaries(localOverrides))
        setTripDirectoryLoaded(true)
        setOverrides(localOverrides)
        setFirestoreState({ status: 'disabled', error: 'Saved on this device' })
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
            setTripSummaries([])
            setTripDirectoryLoaded(false)
            setOverrides({ days: {}, items: {}, bookingOptions: {} })
            setFirestoreState({ status: 'connecting', error: '' })
            try {
              await ensureUserProfile(user)
            } catch (error) {
              console.error(error)
            }
          } else {
            setTripSummaries([])
            setTripDirectoryLoaded(true)
            setOverrides({ days: {}, items: {}, bookingOptions: {} })
            setFirestoreState({ status: 'ready', error: '' })
          }
        },
        (error) => {
          console.error(error)
          if (active) {
            setAuthReady(true)
            setAuthError('Sign-in could not be completed. Please try again.')
            setCurrentUser(null)
            setTripSummaries([])
            setTripDirectoryLoaded(true)
            setOverrides({ days: {}, items: {}, bookingOptions: {} })
            setFirestoreState({ status: 'ready', error: '' })
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
    if (isGuestMode) return undefined
    if (!authReady || !firebaseEnabled || !currentUser?.uid) return undefined

    let active = true
    let unsubscribe = () => {}
    queueMicrotask(() => {
      if (active) setTripDirectoryLoaded(false)
    })

    async function connectDirectory() {
      unsubscribe = await subscribeToUserTripDirectory(
        currentUser.uid,
        (payload) => {
          if (!active) return
          setTripSummaries(payload || [])
          setTripDirectoryLoaded(true)
        },
        (error) => {
          console.error(error)
          if (active) {
            setTripDirectoryLoaded(true)
            setFirestoreState({ status: 'error', error: 'We could not save that change. Please try again.' })
          }
        },
      )
    }

    void connectDirectory()
    return () => {
      active = false
      unsubscribe()
    }
  }, [authReady, currentUser?.uid, isGuestMode])

  useEffect(() => {
    if (!pendingInviteId || !authReady || !isGuestMode) return undefined

    const inviteState = inviteAcceptanceRef.current
    if (inviteState.promptedForId === pendingInviteId || inviteState.inProgress) return undefined

    let active = true
    inviteState.promptedForId = pendingInviteId

    async function promptForInviteSignIn() {
      const confirmed = await showConfirm(
        'Sign in with Google to open this shared trip.',
        {
          title: 'Shared trip',
          confirmLabel: 'Sign in',
          cancelLabel: 'Not now',
        },
      )
      if (!active || !confirmed) return
      try {
        setAuthError('')
        await signInWithGoogle()
      } catch (error) {
        console.error(error)
        setAuthError('Sign-in could not be completed. Please try again.')
      }
    }

    void promptForInviteSignIn()
    return () => {
      active = false
    }
  }, [authReady, isGuestMode, pendingInviteId, showConfirm])

  useEffect(() => {
    if (!pendingInviteId || isGuestMode) return undefined
    if (!authReady || !firebaseEnabled || !currentUser?.uid) return undefined

    const inviteState = inviteAcceptanceRef.current
    if (inviteState.inProgress) return undefined

    let active = true
    inviteState.inProgress = true

    async function acceptInvite() {
      try {
        const invite = await acceptTripInvite(pendingInviteId, currentUser)
        if (!active || !invite?.tripId) return

        setTripSummaries((current) =>
          current.some((trip) => trip.id === invite.tripId)
            ? current
            : [
                ...current,
                {
                  id: invite.tripId,
                  role: invite.role,
                  title: invite.title || 'Shared trip',
                  startDate: invite.startDate || '',
                  endDate: invite.endDate || '',
                  city: invite.city || '',
                  hidden: false,
                  isDemo: Boolean(invite.isDemo),
                  ownerId: invite.ownerId || '',
                  createdBy: invite.createdBy || '',
                },
              ],
        )
        selectTrip(invite.tripId)
        setPendingInviteId('')
        clearInviteUrl()
        await showAlert('This shared trip has been added to your trips.', {
          title: 'Trip added',
        })
      } catch (error) {
        console.error(error)
        if (active) {
          setPendingInviteId('')
          clearInviteUrl()
          await showAlert('This invitation could not be opened. Ask the trip owner for a new link.', {
            title: 'Invitation unavailable',
            tone: 'danger',
          })
        }
      } finally {
        inviteState.inProgress = false
      }
    }

    void acceptInvite()
    return () => {
      active = false
    }
  }, [
    authReady,
    clearInviteUrl,
    currentUser,
    isGuestMode,
    pendingInviteId,
    showAlert,
  ])

  useEffect(() => {
    if (isGuestMode) return undefined
    if (!authReady || !firebaseEnabled || !currentUser?.uid) return undefined
    if (!tripDirectoryLoaded) return undefined

    const uid = currentUser.uid
    const migration = guestMigrationRef.current
    if (migration.promptedForUid === uid || migration.declinedForUid === uid || migration.inProgress) {
      return undefined
    }

    const localOverrides = hasTripOverrides(migration.localOverrides)
      ? migration.localOverrides
      : readLocalTripOverrides()

    if (!hasTripOverrides(localOverrides)) return undefined

    let active = true
    migration.promptedForUid = uid
    migration.inProgress = true

    async function migrateGuestTrip() {
      try {
        const migrationChoice = await showChoice(
          'You have an itinerary saved on this device. Save it to your Google account or remove the device copy?',
          {
            title: 'Save device itinerary',
            choices: [
              { value: 'save', label: 'Save to account', variant: 'primary' },
              { value: 'delete', label: 'Remove device copy', tone: 'danger' },
            ],
          },
        )

        if (!active) return

        if (migrationChoice === 'delete') {
          window.localStorage.removeItem(LOCAL_TRIP_OVERRIDES_KEY)
          migration.localOverrides = null
          migration.localTitle = ''
          migration.declinedForUid = uid
          return
        }

        if (migrationChoice !== 'save') {
          migration.declinedForUid = uid
          return
        }

        const localTripState = deriveTripState(localOverrides)
        const snapshot = buildClonedTripSnapshot(localTripState)
        const tripId = slugId('trip')
        const title = migration.localTitle || 'Imported itinerary'
        const nextSummary = {
          id: tripId,
          title,
          role: 'owner',
          hidden: false,
          startDate: snapshot.startDate,
          endDate: snapshot.endDate,
          city: buildDefaultTripSummary().city,
          ownerId: currentUser.uid,
          createdBy: currentUser.uid,
        }

        await createTripRecordWithOwner(
          tripId,
          {
            title,
            startDate: snapshot.startDate,
            endDate: snapshot.endDate,
            city: nextSummary.city,
            days: snapshot.days,
            items: snapshot.items,
            bookingOptions: snapshot.bookingOptions,
          },
          currentUser,
        )

        if (!active) return

        setTripSummaries((current) =>
          current.some((trip) => trip.id === tripId) ? current : [...current, nextSummary],
        )
        selectTrip(tripId)
        setFirestoreState({ status: 'ready', error: '' })

        await showAlert(
          'Your device itinerary has been saved to your Google account.',
          {
            title: 'Saved to account',
            confirmLabel: 'OK',
          },
        )

        if (!active) return

        window.localStorage.removeItem(LOCAL_TRIP_OVERRIDES_KEY)
        migration.localOverrides = null
        migration.localTitle = ''
      } catch (error) {
        console.error(error)
        if (active) {
          const message = 'We could not save that change. Please try again.'
          setFirestoreState((current) => ({ ...current, status: 'error', error: message }))
          await showAlert(message, { title: 'Save failed', tone: 'danger' })
        }
      } finally {
        migration.inProgress = false
      }
    }

    void migrateGuestTrip()
    return () => {
      active = false
    }
  }, [
    authReady,
    currentUser,
    isGuestMode,
    showAlert,
    showChoice,
    tripDirectoryLoaded,
  ])

  useEffect(() => {
    if (isGuestMode) return undefined
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
            bookingOptions: payload?.bookingOptions || {},
          })
          setFirestoreState({ status: 'ready', error: '' })
        },
        (error) => {
          console.error(error)
          if (active) {
            setFirestoreState({ status: 'error', error: 'We could not save that change. Please try again.' })
          }
        },
      )
    }

    void connectTrip()
    return () => {
      active = false
      unsubscribe()
    }
  }, [authReady, currentUser?.uid, isGuestMode, resolvedTripId])

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
    if (isGuestMode) {
      queueMicrotask(() => setTripMembers([]))
      return undefined
    }

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
  }, [activeRole, authReady, isGuestMode, resolvedTripId])

  const routeItems = useMemo(() => buildRouteTimelineItems(deferredItems), [deferredItems])
  const routePairs = useMemo(() => makeMovementPairs(routeItems), [routeItems])

  function selectTrip(tripId) {
    setOverrides({ days: {}, items: {}, bookingOptions: {} })
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

      await saveTripPatch(
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
  }, [dragState?.itemId, resolvedActiveDayId, resolvedTripId, saveTripPatch, tripState])

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
    if (isGuestMode && hasTripOverrides(overrides)) {
      guestMigrationRef.current.localOverrides = overrides
      guestMigrationRef.current.localTitle = activeTripSummary?.title || defaultTripSummary.title
    }

    try {
      setAuthError('')
      await signInWithGoogle()
    } catch (error) {
      console.error(error)
      setAuthError('Sign-in could not be completed. Please try again.')
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
      setAuthError('Sign-out could not be completed. Please try again.')
    }
  }

  async function saveItem(item) {
    if (!canEditCurrentTrip) return
    const normalizedItem = normalizeItemForSave(stripFlightLocationFields(normalizeItemTimeFields(item)))
    if (normalizedItem.date === PARKING_LOT_DATE) {
      await saveTripPatch(resolvedTripId, {
        items: {
          [normalizedItem.id]: {
            ...normalizedItem,
            dayId: '',
            date: PARKING_LOT_DATE,
            travelModeToNext: '',
          },
        },
      })
      return
    }

    const sameDayItems = (tripState.dayMap[item.dayId]?.items || []).filter((existing) => existing.id !== item.id)
    const manualItems = sameDayItems.filter((existing) => !existing.generated)
    const patchItems = Object.fromEntries(
      mergeItemsForDay(manualItems, { ...normalizedItem, date: '' }).map((entry) => [entry.id, entry]),
    )
    await saveTripPatch(resolvedTripId, { items: patchItems })
  }

  async function createTrip() {
    const nextIndex = availableTrips.length + 1
    const suggestedTitle = `Trip ${nextIndex}`
    const today = localTodayIso()
    const tripDraft = await showTripSetup({
      defaultValue: {
        title: suggestedTitle,
        startDate: today,
        endDate: today,
        city: '',
      },
    })
    if (!tripDraft) return

    const title = tripDraft.title.trim()
    const city = normalizeTripCity(tripDraft.city)
    if (!title || !tripDraft.startDate || !tripDraft.endDate || !city) return
    if (isoDateToUtcMs(tripDraft.endDate) < isoDateToUtcMs(tripDraft.startDate)) {
      await showAlert('End date must be the same as or after the start date.', {
        title: 'Check trip dates',
      })
      return
    }

    const tripId = slugId('trip')
    const snapshot = buildBlankTripSnapshot(tripDraft.startDate, tripDraft.endDate)
    const nextSummary = {
      id: tripId,
      title,
      role: 'owner',
      hidden: false,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
      city,
      ownerId: currentUser?.uid || '',
      createdBy: currentUser?.uid || '',
    }

    if (isGuestMode) {
      setTripSummaries((current) =>
        current.some((trip) => trip.id === tripId) ? current : [...current, nextSummary],
      )
      setOverrides({
        days: snapshot.days,
        items: snapshot.items,
        bookingOptions: snapshot.bookingOptions,
      })
      setActiveTripId(tripId)
      setActiveDayId(DAY_VIEW_ALL)
      setNoteItem(null)
      setDetailItem(null)
      setFirestoreState({ status: 'ready', error: '' })
      return
    }

    if (!firebaseEnabled || !authReady || !currentUser?.uid) return

    try {
      await createTripRecordWithOwner(
        tripId,
        {
          title: nextSummary.title,
          startDate: nextSummary.startDate,
          endDate: nextSummary.endDate,
          city: nextSummary.city,
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
      const message = 'We could not save that change. Please try again.'
      setFirestoreState((current) => ({ ...current, status: 'error', error: message }))
      await showAlert(message, { title: 'Save failed', tone: 'danger' })
    }
  }

  async function cloneTrip() {
    if (!firestoreReady || !canEditCurrentTrip || !activeTripSummary) return

    const suggestedTitle = `${activeTripSummary.title || 'Trip'} copy`
    const title = await showPrompt('Clone trip as', {
      defaultValue: suggestedTitle,
      confirmLabel: 'Clone',
    })
    if (!title) return

    const snapshot = buildClonedTripSnapshot(tripState)
    const tripId = slugId('trip')

    if (isGuestMode) {
      setTripSummaries((current) => [
        ...current,
        {
          id: tripId,
          title,
          role: 'owner',
          hidden: false,
          startDate: snapshot.startDate,
          endDate: snapshot.endDate,
          city: activeTripSummary.city || '',
          ownerId: currentUser?.uid || '',
          createdBy: currentUser?.uid || '',
        },
      ])
      setOverrides({
        days: snapshot.days,
        items: snapshot.items,
        bookingOptions: snapshot.bookingOptions,
      })
      setActiveTripId(tripId)
      setActiveDayId(DAY_VIEW_ALL)
      setNoteItem(null)
      setDetailItem(null)
      return
    }

    if (!firebaseEnabled || !authReady || !currentUser?.uid) return

    try {
      await createTripRecordWithOwner(
        tripId,
        {
          title,
          startDate: snapshot.startDate,
          endDate: snapshot.endDate,
          city: activeTripSummary.city || '',
          days: snapshot.days,
          items: snapshot.items,
          bookingOptions: snapshot.bookingOptions,
        },
        currentUser,
      )

      setTripSummaries((current) =>
        current.some((trip) => trip.id === tripId)
          ? current
          : [
              ...current,
              {
                id: tripId,
                title,
                role: 'owner',
                hidden: false,
                startDate: snapshot.startDate,
                endDate: snapshot.endDate,
                city: activeTripSummary.city || '',
                ownerId: currentUser.uid,
                createdBy: currentUser.uid,
              },
            ],
      )
      selectTrip(tripId)
      setFirestoreState((current) => ({ ...current, error: '' }))
    } catch (error) {
      console.error(error)
      const message = 'We could not save that change. Please try again.'
      setFirestoreState((current) => ({ ...current, status: 'error', error: message }))
      await showAlert(message, { title: 'Save failed', tone: 'danger' })
    }
  }

  async function renameTrip() {
    if (!firestoreReady || !canEditCurrentTrip) return

    const currentTitle = activeTripSummary?.title || 'Untitled trip'
    const nextTitle = await showPrompt('Rename trip', {
      defaultValue: currentTitle,
      confirmLabel: 'Rename',
    })
    if (!nextTitle || nextTitle === currentTitle) return

    if (isGuestMode) {
      setTripSummaries((current) =>
        current.map((trip) => (trip.id === resolvedTripId ? { ...trip, title: nextTitle } : trip)),
      )
      return
    }

    await upsertTripMeta(resolvedTripId, {
      title: nextTitle,
      startDate: tripState.days[0]?.date || activeTripSummary.startDate || '',
      endDate: tripState.days[tripState.days.length - 1]?.date || activeTripSummary.endDate || '',
      city: activeTripSummary.city || '',
    })
  }

  async function deleteTrip() {
    if (!firestoreReady || !canDeleteCurrentTrip) return
    if (resolvedTripId === defaultTripSummary.id) {
      await showAlert('This starter trip cannot be deleted.')
      return
    }

    const tripTitle = activeTripSummary?.title || 'this trip'
    const confirmed = await showConfirm(`Delete ${tripTitle}? This will remove the trip for everyone with access.`, {
      title: 'Delete trip',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return

    const fallbackTrip =
      availableTrips.find((trip) => trip.id !== resolvedTripId && !trip.hidden) || defaultTripSummary

    if (isGuestMode) {
      setTripSummaries((current) => current.filter((trip) => trip.id !== resolvedTripId))
      selectTrip(fallbackTrip.id)
      return
    }

    await deleteTripRecord(resolvedTripId)

    selectTrip(fallbackTrip.id)
  }

  async function restoreTrip(tripId) {
    if (!firestoreReady || !tripId || !canManageCurrentTrip) return
    if (isGuestMode) {
      setTripSummaries((current) =>
        current.map((trip) => (trip.id === tripId ? { ...trip, hidden: false } : trip)),
      )
      selectTrip(tripId)
      return
    }

    await upsertTripMeta(tripId, { hidden: false })
    selectTrip(tripId)
  }

  async function updateDay(dayId, changes) {
    if (!canEditCurrentTrip) return
    if (changes.date) {
      const duplicate = visibleDays.find((day) => day.id !== dayId && day.date === changes.date)
      if (duplicate) {
        await showAlert('Each day must use a different date.')
        return
      }
    }
    await saveTripPatch(resolvedTripId, { days: { [dayId]: changes } })
  }

  async function addDay(draft) {
    if (!firestoreReady || !canEditCurrentTrip || !draft.date) return
    if (visibleDays.some((day) => day.date === draft.date)) {
      await showAlert('That date is already in this itinerary.')
      return
    }

    const id = slugId('day')
    await saveTripPatch(resolvedTripId, {
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
    await saveTripPatch(resolvedTripId, {
      days: Object.fromEntries(
        renumberDays(reordered).map((entry) => [entry.id, { order: entry.order }]),
      ),
    })
  }

  async function deleteDay(dayId) {
    if (!canEditCurrentTrip) return
    const day = tripState.dayMap[dayId]
    if (!day) return
    const confirmed = await showConfirm(`Delete ${day.label}? All stops on this day will be removed.`, {
      title: 'Delete day',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return

    const remaining = visibleDays.filter((entry) => entry.id !== dayId)
    await saveTripPatch(resolvedTripId, {
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
    if (!canEditCurrentTrip) return false
    const targetItem = [...tripState.items, ...(tripState.parkingLotItems || [])].find((item) => item.id === itemId)
    const confirmed = await showConfirm(
      `Delete ${targetItem?.title || 'this event'}? This stop will be removed from the itinerary.`,
      {
        title: 'Delete event',
        confirmLabel: 'Delete',
        tone: 'danger',
      },
    )
    if (!confirmed) return false

    await saveTripPatch(resolvedTripId, {
      items: { [itemId]: { hidden: true } },
      bookingOptions: Object.fromEntries(
        tripState.bookingOptions
          .filter((booking) => booking.linkedItemId === itemId)
          .map((booking) => [booking.id, { hidden: true }]),
      ),
    })
    setNoteItem((current) => (current?.id === itemId ? null : current))
    setDetailItem((current) => (current?.id === itemId ? null : current))
    return true
  }

  async function duplicateItem(item) {
    if (!firestoreReady || !canEditCurrentTrip || !item || item.generated) return

    const duplicate = normalizeItemForSave({
      ...createItemDraft(item),
      id: slugId('item'),
      generated: false,
      sourceItemId: '',
      order: (item.order ?? 0) + 1,
    })

    await saveItem(duplicate)
    setNoteItem(null)
    setDetailItem(createItemDraft(duplicate))
  }

  async function addSubstituteItem(item) {
    if (!firestoreReady || !canEditCurrentTrip || !item || item.generated) {
      return
    }

    const substituteGroupId = item.substituteGroupId || slugId('substitute-group')
    const sourceItem = normalizeItemForSave({
      ...createItemDraft(item),
      substituteGroupId,
    })
    const substitute = normalizeItemForSave({
      ...createItemDraft(item),
      id: slugId('item'),
      title: 'Substitute option',
      locationName: '',
      address: '',
      lat: null,
      lng: null,
      placeId: '',
      description: '',
      bookingRef: '',
      status: 'considering',
      cancellationDeadline: '',
      generated: false,
      sourceItemId: '',
      substituteGroupId,
      substituteOfItemId: item.substituteOfItemId || item.id,
      order: (item.order ?? 0) + 1,
    })
    const sameDayItems = (tripState.dayMap[item.dayId]?.items || []).filter(
      (existing) => !existing.generated && ![sourceItem.id, substitute.id].includes(existing.id),
    )
    const patchItems = Object.fromEntries(
      normalizeDayTimelineOrder(
        [...sameDayItems, sourceItem, substitute].map((entry) => normalizeItemForSave(entry)),
        item.dayId,
      ).map((entry) => [entry.id, entry]),
    )

    await saveTripPatch(resolvedTripId, { items: patchItems })
    setNoteItem(null)
    setDetailItem(createItemDraft(substitute))
  }

  async function promoteSubstituteItem(item) {
    if (!firestoreReady || !canEditCurrentTrip || !item?.substituteGroupId) return

    const groupItems = tripState.items.filter(
      (candidate) => candidate.substituteGroupId === item.substituteGroupId && !candidate.generated,
    )
    if (!groupItems.some((candidate) => candidate.id === item.id)) return

    const nextGroupItems = groupItems.map((candidate) =>
      normalizeItemForSave(
        stripFlightLocationFields(
          normalizeItemTimeFields({
            ...candidate,
            status: candidate.id === item.id ? 'active' : 'considering',
          }),
        ),
      ),
    )

    const patch = {
      items: Object.fromEntries(nextGroupItems.map((candidate) => [candidate.id, candidate])),
    }

    setOverrides((current) => mergeTripOverrides(current, patch))
    await saveTripPatch(resolvedTripId, patch)
  }

  async function updateTravelMode(itemId, travelModeToNext) {
    if (!canEditCurrentTrip) return
    const targetItem = tripState.items.find((item) => item.id === itemId)
    if (!targetItem) return

    if (targetItem.generated) {
      await saveTripPatch(resolvedTripId, {
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
      await saveTripPatch(resolvedTripId, {
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
    if (!canManageCurrentTrip) return
    if (!['admin', 'editor', 'viewer'].includes(role)) return
    if (isGuestMode) {
      await showAlert('Sign in with Google to share trips and manage collaborator access.')
      return
    }
    if (!currentUser?.uid) return

    const match = await lookupUserByEmail(email)
    if (!match) {
      await showAlert('Ask this person to sign in once before adding them.')
      return
    }
    if (match.uid === currentUser.uid) {
      await showAlert('You are already on this trip.')
      return
    }
    if (tripMembers.some((member) => member.uid === match.uid)) {
      await showAlert('This person is already a collaborator on the trip.')
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
        city: activeTripSummary.city || '',
        hidden: false,
        ownerId: activeTripSummary.ownerId || currentUser.uid,
        createdBy: activeTripSummary.createdBy || currentUser.uid,
      },
    )
  }

  async function createInvitationLink(role) {
    if (!canManageCurrentTrip) return ''
    if (!['admin', 'editor', 'viewer'].includes(role)) return ''
    if (isGuestMode) {
      await showAlert('Sign in with Google to create invitation links.')
      return ''
    }
    if (!currentUser?.uid) return ''

    const invite = await createTripInvite(
      resolvedTripId,
      currentUser,
      role,
      {
        title: activeTripSummary.title,
        startDate: activeTripSummary.startDate,
        endDate: activeTripSummary.endDate,
        city: activeTripSummary.city || '',
        hidden: false,
        isDemo: activeTripSummary.isDemo,
        ownerId: activeTripSummary.ownerId || currentUser.uid,
        createdBy: activeTripSummary.createdBy || currentUser.uid,
      },
    )
    if (!invite?.inviteId) return ''

    const link = `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(invite.inviteId)}`
    try {
      await navigator.clipboard?.writeText(link)
    } catch (error) {
      console.error(error)
    }
    return link
  }

  async function changeCollaboratorRole(member, role) {
    if (!canManageCurrentTrip) return
    if (!['admin', 'editor', 'viewer'].includes(role)) return
    if (member.uid === currentUser?.uid) {
      await showAlert('You cannot change your own access.')
      return
    }

    if (member.role === 'owner') {
      await showAlert('The owner’s access cannot be changed.')
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
        city: activeTripSummary.city || '',
        hidden: false,
        ownerId: activeTripSummary.ownerId || currentUser?.uid || '',
        createdBy: activeTripSummary.createdBy || currentUser?.uid || '',
      },
    )
  }

  async function removeCollaborator(member) {
    if (!canManageCurrentTrip) return
    if (member.uid === currentUser?.uid) {
      await showAlert('You cannot remove your own access.')
      return
    }

    if (member.role === 'owner') {
      await showAlert('The owner cannot be removed from the trip.')
      return
    }

    const confirmed = await showConfirm(`Remove ${member.displayName || member.email || member.uid} from this trip?`, {
      title: 'Remove collaborator',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!confirmed) return
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

  const handleOpenPdfExportOptions = () => {
    setShowMenu(false)
    setShowPdfExportOptions(true)
  }

  const handleShareOverviewPdf = async () => {
    if (pdfExporting) return
    setPdfExporting(true)
    try {
      await shareTripOverviewPdf({
        days: visibleDays,
        items: tripState.items,
        tripSummary: activeTripSummary,
      })
      setShowPdfExportOptions(false)
    } catch (error) {
      if (error?.name === 'NotSupportedError') {
        await showAlert('Sharing is not available on this device. Download the itinerary instead.')
      } else if (error?.name !== 'AbortError') {
        console.error('PDF share failed', error)
        await showAlert('Could not share the overview PDF. Please try again.', {
          title: 'Share failed',
          tone: 'danger',
        })
      }
    } finally {
      setPdfExporting(false)
    }
  }

  const handleDownloadOverviewPdf = async () => {
    if (pdfExporting) return
    setPdfExporting(true)
    try {
      await downloadTripOverviewPdf({
        days: visibleDays,
        items: tripState.items,
        tripSummary: activeTripSummary,
      })
      setShowPdfExportOptions(false)
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('PDF download failed', error)
        await showAlert('Could not download the overview PDF. Please try again.', {
          title: 'Download failed',
          tone: 'danger',
        })
      }
    } finally {
      setPdfExporting(false)
    }
  }

  if (!authReady) {
    return (
      <main className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-10 text-slate-600">
        <div className="glass-panel rounded-[1.25rem] border border-white/60 px-5 py-4 text-sm font-medium">
          Opening your trip...
        </div>
      </main>
    )
  }

  return (
    <main className="app-main mx-auto min-h-screen max-w-7xl overflow-x-clip px-3 py-3.5 pb-24 text-slate-900 sm:px-6 sm:py-5 sm:pb-24 lg:px-8">
      <MenuButton onClick={() => setShowMenu(true)} />
      <AppDrawer
        activeTripSummary={activeTripSummary}
        authError={authError}
        availableTrips={availableTrips}
        canDeleteCurrentTrip={canDeleteCurrentTrip}
        canEditCurrentTrip={canEditCurrentTrip}
        canShare={isSignedIn && canViewTrip(activeRole)}
        currentUser={effectiveUser}
        deletedTrips={deletedTrips}
        disabled={false}
        isGuestMode={isGuestMode}
        isMobilePortrait={isMobilePortrait}
        onCloneTrip={() => void cloneTrip()}
        onClose={() => setShowMenu(false)}
        onCreateTrip={() => void createTrip()}
        onDeleteTrip={() => void deleteTrip()}
        onExportOverview={handleOpenPdfExportOptions}
        onOpenDeadlines={() => {
          setShowMenu(false)
          setShowParkingLot(false)
          setShowDeadlines(true)
        }}
        onOpenItinerary={() => {
          setShowMenu(false)
          setShowDeadlines(false)
          setShowParkingLot(false)
        }}
        onOpenParkingLot={() => {
          setShowMenu(false)
          setShowDeadlines(false)
          setShowParkingLot(true)
        }}
        onRenameTrip={() => void renameTrip()}
        onRestoreTrip={(tripId) => void restoreTrip(tripId)}
        onSelectTrip={(tripId) => {
          selectTrip(tripId)
          setShowMenu(false)
          setShowDeadlines(false)
          setShowParkingLot(false)
        }}
        onShare={() => {
          setShowMenu(false)
          setShowCollaborators(true)
        }}
        onSignIn={() => {
          setShowMenu(false)
          void handleSignIn()
        }}
        onSignOut={() => {
          setShowMenu(false)
          void handleSignOut()
        }}
        open={showMenu}
        pdfExporting={pdfExporting}
        showingUtilityScreen={showDeadlines || showParkingLot}
        urgentDeadlineCount={urgentDeadlineCount}
      />
      <PdfExportSheet
        loading={pdfExporting}
        onClose={() => {
          if (!pdfExporting) setShowPdfExportOptions(false)
        }}
        onDownload={() => void handleDownloadOverviewPdf()}
        onShare={() => void handleShareOverviewPdf()}
        open={showPdfExportOptions}
      />
      <AppDialog
        dialog={appDialog}
        onCancel={() =>
          closeAppDialog(appDialog?.type === 'alert' ? true : appDialog?.type === 'confirm' ? false : null)
        }
        onSubmit={(result) => closeAppDialog(result)}
      />
      {!availableTrips.length ? (
        <div className="glass-panel max-w-md rounded-[1.08rem] px-5 py-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-slate-400">Trips</div>
          <h2 className="mt-2 text-[1.35rem] font-extrabold tracking-[-0.03em] text-slate-950">Start a trip</h2>
          <p className="mt-2 text-[13px] leading-6 text-slate-600">
            You do not have an itinerary yet. Create a new trip to start planning, or open an invitation from a trip owner.
          </p>
          <button
            type="button"
            onClick={() => void createTrip()}
            disabled={!authReady || (!isGuestMode && (!firebaseEnabled || !currentUser?.uid))}
            className="mt-4 rounded-[0.9rem] bg-slate-950 px-4 py-3 text-sm font-bold text-white shadow-[0_10px_22px_rgba(15,23,42,0.10)] transition hover:bg-slate-800 disabled:bg-slate-300"
          >
            Create trip
          </button>
        </div>
      ) : null}
      {availableTrips.length ? (
        showDeadlines ? (
          <section className={isMobilePortrait ? 'mx-auto max-w-[28rem]' : ''}>
            <CancellationDeadlinesScreen
              bookingOptions={tripState.bookingOptions}
              canEdit={canEditCurrentTrip}
              isMobilePortrait={isMobilePortrait}
              items={tripState.items}
              onOpenDetails={openDetails}
            />
          </section>
        ) : showParkingLot ? (
          <section className={isMobilePortrait ? 'mx-auto max-w-[28rem]' : ''}>
            <ParkingLotScreen
              activeDayId={resolvedActiveDayId}
              canEdit={canEditCurrentTrip}
              dayMap={tripState.dayMap}
              dayOptions={dayOptions}
              firestoreReady={firestoreReady}
              focusedDayId={navFocusedDayId}
              getFlightRecord={getFlightRecord}
              isMobilePortrait={isMobilePortrait}
              items={tripState.parkingLotItems || []}
              mapsReady={googleMapsState.ready}
              onOpenDetails={{
                startPress,
                movePress,
                endPress,
                cancelPress: clearPressState,
              }}
              onSaveNewItem={saveItem}
            />
          </section>
        ) : (
          <section
            className={
              isMobilePortrait
                ? 'mx-auto max-w-[28rem] space-y-3'
                : 'grid gap-7 lg:grid-cols-[minmax(0,1.06fr)_minmax(22rem,0.94fr)] xl:gap-8'
            }
          >
            <div className={isMobilePortrait ? 'space-y-3' : 'space-y-4'}>
              <PlannerPanel
                activeDayId={resolvedActiveDayId}
                bookingOptions={tripState.bookingOptions}
                canEdit={canEditCurrentTrip}
                dayOptions={dayOptions}
                dayMap={tripState.dayMap}
                dragState={dragState}
                filteredItems={filteredItems}
                focusedDayId={navFocusedDayId}
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
                onPromoteSubstitute={(item) => promoteSubstituteItem(item)}
                onSaveNewItem={saveItem}
                onUpdateTravelMode={(itemId, mode) => void updateTravelMode(itemId, mode)}
                routeSegmentMap={routeSegmentMap}
                selectedWeather={selectedWeather}
                weatherState={effectiveWeatherState}
              />
            </div>

            <div className="space-y-3 lg:sticky lg:top-6 lg:self-start">
              <MemoMapPanel
                activeDayId={resolvedActiveDayId}
                fallbackLocationLabel={activeTripSummary?.city || ''}
                filteredItems={deferredItems}
                isMobilePortrait={isMobilePortrait}
                mapsReady={googleMapsState.ready}
                mapsError={googleMapsState.error}
                routeSegments={routeSegments}
              />
            </div>
          </section>
        )
      ) : null}

      {availableTrips.length && !showDeadlines && !showParkingLot ? (
        <BottomDayNav
          activeDayId={resolvedActiveDayId}
          canEdit={canEditCurrentTrip}
          dayOptions={dayOptions}
          dragState={dragState}
          focusedDayId={navFocusedDayId}
          overbookingCountsByDay={overbookingCountsByDay}
          onDayChange={(dayId) => {
            startTransition(() => {
              setShowDeadlines(false)
              setShowParkingLot(false)
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
          onAddSubstitute={async () => {
            const match = tripState.items.find((item) => item.id === noteItem.id) || noteItem
            await addSubstituteItem(match)
          }}
          onClose={() => setNoteItem(null)}
          onDelete={async () => {
            const id = noteItem.id
            const deleted = await deleteItem(id)
            if (deleted) setNoteItem(null)
          }}
          onDuplicate={async () => {
            const match = tripState.items.find((item) => item.id === noteItem.id) || noteItem
            await duplicateItem(match)
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
            const deleted = await deleteItem(id)
            if (deleted) setDetailItem(null)
          }}
        />
      ) : null}

      {showCollaborators && canViewTrip(activeRole) ? (
        <CollaboratorsModal
          canManageTrip={canManageCurrentTrip}
          currentRole={activeRole}
          currentUser={currentUser}
          isMobilePortrait={isMobilePortrait}
          members={tripMembers}
          onAddMember={(email, role) => addCollaborator(email, role)}
          onClose={() => setShowCollaborators(false)}
          onCreateInvite={(role) => createInvitationLink(role)}
          onRemoveMember={(member) => removeCollaborator(member)}
          onUpdateRole={(member, role) => changeCollaboratorRole(member, role)}
        />
      ) : null}
    </main>
  )
}
