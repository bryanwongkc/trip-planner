import { SEED_DAYS, SEED_ITEMS } from '../data/seedItinerary'

export const DAY_VIEW_ALL = 'all'

export function slugId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`
}

export function compareTime(a = '00:00', b = '00:00') {
  return a.localeCompare(b)
}

export function timeToMinutes(time = '00:00') {
  const [hours = 0, minutes = 0] = String(time || '00:00').split(':').map(Number)
  return hours * 60 + minutes
}

export function minutesToTime(totalMinutes) {
  const normalized = ((Number(totalMinutes || 0) % 1440) + 1440) % 1440
  const hours = Math.floor(normalized / 60)
  const minutes = normalized % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function deriveEndTimeFromDuration(startTime, durationMinutes) {
  const duration = Number(durationMinutes || 0)
  if (!startTime || !duration) return startTime || '00:00'
  return minutesToTime(timeToMinutes(startTime) + duration)
}

export function getDurationMinutes(startTime, endTime) {
  if (!startTime || !endTime) return null
  const diff = timeToMinutes(endTime) - timeToMinutes(startTime)
  return diff >= 0 ? diff : null
}

export function normalizeItemTimeFields(item) {
  const endTimeMode = item.endTimeMode === 'duration' ? 'duration' : 'time'
  const parsedDuration = Number(item.durationMinutes)
  const durationMinutes = Number.isFinite(parsedDuration) ? parsedDuration : null

  if (endTimeMode === 'duration' && durationMinutes) {
    return {
      ...item,
      endTimeMode,
      durationMinutes,
      endTime: deriveEndTimeFromDuration(item.startTime, durationMinutes),
    }
  }

  return {
    ...item,
    endTimeMode,
    durationMinutes,
  }
}

export function stripFlightLocationFields(item) {
  if (item?.category !== 'Flight') return item

  return {
    ...item,
    locationName: '',
    address: '',
    lat: null,
    lng: null,
    placeId: '',
  }
}

export function sortItemsByTimeline(items) {
  return [...items]
    .filter((item) => !item.hidden)
    .sort((a, b) => {
      const timeCompare = compareTime(a.startTime || '23:59', b.startTime || '23:59')
      if (timeCompare !== 0) return timeCompare
      return (a.order ?? 0) - (b.order ?? 0)
    })
}

export function normalizeDayTimelineOrder(items, dayId) {
  return sortItemsByTimeline(items.filter((item) => item.dayId === dayId)).map((item, index) => ({
    ...normalizeItemTimeFields(item),
    order: index,
  }))
}

export function formatDayDate(date) {
  return new Intl.DateTimeFormat('en-HK', {
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T12:00:00`))
}

export function formatFullDayDate(date) {
  return new Intl.DateTimeFormat('en-HK', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T12:00:00`))
}

export function buildDayLabel(day, index) {
  return `Day ${index + 1} — ${formatDayDate(day.date)}`
}

function mergeEntityMap(seedList, overrides = {}) {
  const seedIds = new Set(seedList.map((entity) => entity.id))
  const merged = seedList.map((entity) => ({ ...entity, ...(overrides[entity.id] || {}) }))
  const extra = Object.entries(overrides)
    .filter(([id]) => !seedIds.has(id))
    .map(([id, entity]) => ({ id, ...entity }))

  return [...merged, ...extra]
}

function isSameHotel(a, b) {
  if (!a || !b) return false
  if (a.placeId && b.placeId) return a.placeId === b.placeId
  if (typeof a.lat === 'number' && typeof b.lat === 'number') {
    return Math.abs(a.lat - b.lat) < 0.0001 && Math.abs(a.lng - b.lng) < 0.0001
  }
  return (
    (a.locationName || '').trim().toLowerCase() === (b.locationName || '').trim().toLowerCase() &&
    (a.address || '').trim().toLowerCase() === (b.address || '').trim().toLowerCase()
  )
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

function hasActiveStayStatus(item) {
  return item?.status === 'active'
}

function chooseHotelStackLead(items) {
  return [...items].sort((a, b) => {
    const activeCompare = Number(hasActiveStayStatus(b)) - Number(hasActiveStayStatus(a))
    if (activeCompare !== 0) return activeCompare
    const timeCompare = itemInterval(a).start - itemInterval(b).start
    if (timeCompare !== 0) return timeCompare
    return (a.order ?? 0) - (b.order ?? 0)
  })[0]
}

function selectContinuityHotel(dayItems, fallbackHotel) {
  if (!fallbackHotel) return null

  const hotels = dayItems.filter((item) => item.category === 'Hotel' && !item.generated)
  const cluster = [fallbackHotel]
  const seen = new Set([fallbackHotel.id])

  let expanded = true
  while (expanded) {
    expanded = false
    hotels.forEach((hotel) => {
      if (seen.has(hotel.id)) return
      const overlapsCluster = cluster.some((candidate) =>
        intervalsOverlap(itemInterval(hotel), itemInterval(candidate)),
      )
      if (!overlapsCluster) return
      seen.add(hotel.id)
      cluster.push(hotel)
      expanded = true
    })
  }

  return cluster.length > 1 ? chooseHotelStackLead(cluster) : fallbackHotel
}

function sortDays(days) {
  return [...days]
    .filter((day) => !day.hidden)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function sortItems(items) {
  return sortItemsByTimeline(
    items.map((item) => stripFlightLocationFields(normalizeItemTimeFields(item))),
  )
    .sort((a, b) => {
      if ((a.generated ? 0 : 1) !== (b.generated ? 0 : 1)) {
        return (a.generated ? 0 : 1) - (b.generated ? 0 : 1)
      }
      const timeCompare = compareTime(a.startTime || '23:59', b.startTime || '23:59')
      if (timeCompare !== 0) return timeCompare
      return (a.order ?? 0) - (b.order ?? 0)
    })
}

export function reorderTripItems(tripState, itemId, targetDayId, targetIndex) {
  const movingItem = tripState.items.find((item) => item.id === itemId && !item.generated)
  if (!movingItem || !tripState.dayMap[targetDayId]) return []

  const sourceDayId = movingItem.dayId
  const sourceItems = (tripState.dayMap[sourceDayId]?.items || []).filter(
    (item) => !item.generated && item.id !== itemId,
  )
  const targetBaseItems =
    sourceDayId === targetDayId
      ? sourceItems
      : (tripState.dayMap[targetDayId]?.items || []).filter(
          (item) => !item.generated && item.id !== itemId,
        )

  const insertAt = Math.max(0, Math.min(targetIndex, targetBaseItems.length))
  const targetItems = [...targetBaseItems]
  targetItems.splice(insertAt, 0, { ...movingItem, dayId: targetDayId })

  const normalizeItems = (items, dayId) =>
    items.map((item, index) => ({
      ...item,
      dayId,
      order: index,
    }))

  if (sourceDayId === targetDayId) {
    return normalizeItems(targetItems, targetDayId)
  }

  return [...normalizeItems(sourceItems, sourceDayId), ...normalizeItems(targetItems, targetDayId)]
}

function buildGeneratedHotelItem(sourceItem, dayId, nextStartTime) {
  return {
    id: `generated-hotel:${sourceItem.id}:${dayId}`,
    dayId,
    order: -1,
    title: sourceItem.title,
    locationName: sourceItem.locationName,
    address: sourceItem.address,
    category: 'Hotel',
    startTime: '00:00',
    endTime: nextStartTime || '09:00',
    description: 'Auto-linked from the previous day hotel stay.',
    bookingRef: sourceItem.bookingRef || '',
    travelModeToNext: sourceItem.travelModeToNext || '',
    lat: sourceItem.lat,
    lng: sourceItem.lng,
    placeId: sourceItem.placeId || '',
    generated: true,
    sourceItemId: sourceItem.id,
  }
}

export function deriveTripState(overrides) {
  const dayMap = Object.fromEntries(mergeEntityMap(SEED_DAYS, overrides.days).map((day) => [day.id, day]))
  const bookingOptions = Object.values(overrides.bookingOptions || {})
    .map(normalizeBookingOption)
    .filter((booking) => !booking.hidden)
  const generatedItemOverrides = Object.fromEntries(
    Object.entries(overrides.items || {}).filter(([id]) => id.startsWith('generated-hotel:')),
  )
  const itemMap = Object.fromEntries(
    mergeEntityMap(
      SEED_ITEMS,
      Object.fromEntries(
        Object.entries(overrides.items || {}).filter(([id]) => !id.startsWith('generated-hotel:')),
      ),
    ).map((item) => [item.id, item]),
  )

  const days = sortDays(Object.values(dayMap))
  const itemBuckets = Object.fromEntries(days.map((day) => [day.id, []]))

  Object.values(itemMap)
    .filter((item) => !item.hidden && item.dayId && itemBuckets[item.dayId])
    .forEach((item) => {
      itemBuckets[item.dayId].push(item)
    })

  days.forEach((day) => {
    itemBuckets[day.id] = sortItems(itemBuckets[day.id] || [])
  })

  const generatedItems = []

  for (let index = 0; index < days.length - 1; index += 1) {
    const day = days[index]
    const nextDay = days[index + 1]
    const dayItems = itemBuckets[day.id] || []
    const nextDayItems = itemBuckets[nextDay.id] || []
    const trailingHotel = selectContinuityHotel(
      dayItems,
      [...dayItems].reverse().find((item) => item.category === 'Hotel' && !item.generated),
    )

    if (!trailingHotel) continue

    const firstManual = nextDayItems.find((item) => !item.generated)
    if (firstManual?.category === 'Hotel' && isSameHotel(trailingHotel, firstManual)) {
      continue
    }

    const generatedItem = buildGeneratedHotelItem(trailingHotel, nextDay.id, firstManual?.startTime)
    const override = generatedItemOverrides[generatedItem.id] || {}

    generatedItems.push({
      ...generatedItem,
      startTime: override.startTime || generatedItem.startTime,
      endTime: override.endTime || generatedItem.endTime,
      description: override.description ?? generatedItem.description,
      bookingRef: override.bookingRef ?? generatedItem.bookingRef,
      travelModeToNext: override.travelModeToNext ?? generatedItem.travelModeToNext,
    })
  }

  generatedItems.forEach((item) => {
    itemBuckets[item.dayId] = sortItems([item, ...(itemBuckets[item.dayId] || [])])
  })

  const dayViews = days.map((day, index) => ({
    ...day,
    dayNumber: index + 1,
    label: buildDayLabel(day, index),
    items: itemBuckets[day.id] || [],
  }))

  const allItems = dayViews.flatMap((day) =>
    day.items.map((item) => ({
      ...item,
      dayId: day.id,
      dayDate: day.date,
      dayLabel: day.label,
      dayNumber: day.dayNumber,
    })),
  )

  return {
    days: dayViews,
    items: allItems,
    bookingOptions,
    dayMap: Object.fromEntries(dayViews.map((day) => [day.id, day])),
  }
}

export function movementItemsForDay(activeDayId, tripState) {
  if (activeDayId === DAY_VIEW_ALL) return tripState.items
  return tripState.dayMap[activeDayId]?.items || []
}

export function nextDayDate(days) {
  if (!days.length) return '2026-05-09'
  const maxDate = [...days].sort((a, b) => a.date.localeCompare(b.date))[days.length - 1]?.date
  const next = new Date(`${maxDate}T00:00:00+09:00`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

export function renumberDays(days) {
  return days.map((day, index) => ({
    ...day,
    order: index,
  }))
}

export function normalizeBookingOption(option = {}) {
  return {
    id: option.id || '',
    linkedItemId: option.linkedItemId || '',
    dayId: option.dayId || '',
    type: option.type === 'meal' ? 'meal' : 'hotel',
    title: option.title || '',
    provider: option.provider || '',
    bookingRef: option.bookingRef || '',
    status: ['active', 'tentative', 'cancelled'].includes(option.status) ? option.status : 'tentative',
    startDate: option.startDate || '',
    endDate: option.endDate || '',
    reservationTime: option.reservationTime || '',
    partySize: Number.isFinite(Number(option.partySize)) ? Number(option.partySize) : null,
    cancellationDeadline: option.cancellationDeadline || '',
    cancellationPolicy: option.cancellationPolicy || '',
    price: Number.isFinite(Number(option.price)) ? Number(option.price) : null,
    currency: option.currency || 'JPY',
    notes: option.notes || '',
    hidden: Boolean(option.hidden),
  }
}

export function deriveBookingDeadlineState(booking, now = new Date()) {
  if (booking?.status === 'cancelled') return 'cancelled'
  if (!booking?.cancellationDeadline) return 'no_deadline'

  const deadline = new Date(booking.cancellationDeadline)
  if (Number.isNaN(deadline.getTime())) return 'invalid_deadline'

  const diffMs = deadline.getTime() - now.getTime()
  if (diffMs < 0) return 'overdue'
  if (diffMs <= 24 * 60 * 60 * 1000) return 'due_soon'
  if (diffMs <= 7 * 24 * 60 * 60 * 1000) return 'upcoming'
  return 'later'
}

export function sortBookingOptionsByDeadline(bookings, now = new Date()) {
  return [...bookings].sort((a, b) => {
    const aState = deriveBookingDeadlineState(a, now)
    const bState = deriveBookingDeadlineState(b, now)
    const stateRank = {
      overdue: 0,
      due_soon: 1,
      upcoming: 2,
      later: 3,
      no_deadline: 4,
      invalid_deadline: 5,
      cancelled: 6,
    }
    const rankCompare = (stateRank[aState] ?? 9) - (stateRank[bState] ?? 9)
    if (rankCompare !== 0) return rankCompare

    const aTime = a.cancellationDeadline ? new Date(a.cancellationDeadline).getTime() : Infinity
    const bTime = b.cancellationDeadline ? new Date(b.cancellationDeadline).getTime() : Infinity
    return aTime - bTime
  })
}

export function bookingsForItem(bookings, itemId, { includeCancelled = false } = {}) {
  return bookings.filter(
    (booking) =>
      booking.linkedItemId === itemId &&
      !booking.hidden &&
      (includeCancelled || booking.status !== 'cancelled'),
  )
}

export function nextCancellationDeadline(bookings, now = new Date()) {
  return (
    sortBookingOptionsByDeadline(
      bookings.filter((booking) => booking.status !== 'cancelled' && booking.cancellationDeadline),
      now,
    )[0] || null
  )
}
