import { SEED_DAYS, SEED_ITEMS } from '../data/seedItinerary'

export const DAY_VIEW_ALL = 'all'

export function slugId(prefix) {
  return `${prefix}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`
}

export function compareTime(a = '00:00', b = '00:00') {
  return a.localeCompare(b)
}

export function formatDayDate(date) {
  return new Intl.DateTimeFormat('en-HK', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(`${date}T00:00:00+09:00`))
}

export function formatFullDayDate(date) {
  return new Intl.DateTimeFormat('en-HK', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(`${date}T00:00:00+09:00`))
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

function sortDays(days) {
  return [...days]
    .filter((day) => !day.hidden)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function sortItems(items) {
  return [...items]
    .filter((item) => !item.hidden)
    .sort((a, b) => {
      if ((a.generated ? 0 : 1) !== (b.generated ? 0 : 1)) {
        return (a.generated ? 0 : 1) - (b.generated ? 0 : 1)
      }
      if (typeof a.order === 'number' && typeof b.order === 'number' && a.order !== b.order) {
        return a.order - b.order
      }
      const timeCompare = compareTime(a.startTime, b.startTime)
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
    const trailingHotel = [...dayItems].reverse().find((item) => item.category === 'Hotel' && !item.generated)

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
