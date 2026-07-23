const ITINERARY_ITEM_PALETTE = [
  { solid: '#0f766e', soft: '#ccfbf1' },
  { solid: '#c2410c', soft: '#ffedd5' },
  { solid: '#1d4ed8', soft: '#dbeafe' },
  { solid: '#a21caf', soft: '#fae8ff' },
  { solid: '#15803d', soft: '#dcfce7' },
  { solid: '#6d28d9', soft: '#ede9fe' },
  { solid: '#be123c', soft: '#ffe4e6' },
  { solid: '#0e7490', soft: '#cffafe' },
  { solid: '#b45309', soft: '#fef3c7' },
  { solid: '#4338ca', soft: '#e0e7ff' },
  { solid: '#9f1239', soft: '#ffe4e6' },
  { solid: '#7c2d12', soft: '#ffedd5' },
]

export function getItineraryItemColor(index) {
  const normalizedIndex = Math.max(0, Number.isFinite(Number(index)) ? Number(index) : 0)
  if (normalizedIndex < ITINERARY_ITEM_PALETTE.length) {
    return ITINERARY_ITEM_PALETTE[normalizedIndex]
  }

  const hue = Math.round((normalizedIndex * 137.508 + 193) % 360)
  return {
    solid: `hsl(${hue} 62% 36%)`,
    soft: `hsl(${hue} 72% 93%)`,
  }
}

export function assignItineraryItemColors(items) {
  const dayCounts = new Map()

  return items.map((item) => {
    const dayKey = item?.dayId || ''
    const dayIndex = dayCounts.get(dayKey) || 0
    dayCounts.set(dayKey, dayIndex + 1)

    return {
      itemId: item?.id || '',
      dayId: dayKey,
      dayIndex,
      color: getItineraryItemColor(dayIndex),
    }
  })
}
