import { timeToMinutes } from './trip'

export function isStackableStayOrMeal(item) {
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

export function hasActiveStayOrMealStatus(item) {
  return item?.status === 'active'
}

export function hasActiveSelectionStatus(item) {
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

export function buildTimelineEntries(items) {
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

export function buildRouteTimelineItems(items) {
  return buildTimelineEntries(items).map((entry) => entry.item)
}
