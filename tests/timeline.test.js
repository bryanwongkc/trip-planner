import { describe, expect, it } from 'vitest'
import { duplicateItemAsIndependent } from '../src/utils/trip'
import { buildRouteTimelineItems, buildTimelineEntries } from '../src/utils/timeline'

const baseItems = [
  {
    id: 'cheese-garden',
    dayId: 'day-2',
    title: 'Cheese Garden',
    category: 'Activity',
    startTime: '15:15',
    endTime: '16:15',
    status: 'active',
    substituteGroupId: 'group-3',
  },
  {
    id: 'a-cowherd',
    dayId: 'day-2',
    title: 'A Cowherd',
    category: 'Activity',
    startTime: '17:00',
    endTime: '18:00',
    status: 'considering',
    substituteGroupId: 'group-3',
    substituteOfItemId: 'cheese-garden',
  },
  {
    id: 'cafe-garden',
    dayId: 'day-2',
    title: 'Café & Garden',
    category: 'Activity',
    startTime: '18:00',
    endTime: '19:00',
    status: 'active',
  },
]

describe('substitute items in route and map timelines', () => {
  it('omits an inactive substitute without shifting the following map marker', () => {
    expect(buildRouteTimelineItems(baseItems).map((item) => item.id)).toEqual([
      'cheese-garden',
      'cafe-garden',
    ])
  })

  it('uses the substitute when the user promotes it to active', () => {
    const promotedItems = baseItems.map((item) => ({
      ...item,
      status: item.id === 'a-cowherd' ? 'active' : item.id === 'cheese-garden' ? 'considering' : item.status,
    }))

    expect(buildRouteTimelineItems(promotedItems).map((item) => item.id)).toEqual([
      'a-cowherd',
      'cafe-garden',
    ])
  })

  it('keeps a duplicate of a grouped event as an independent timeline item', () => {
    const duplicate = duplicateItemAsIndependent(baseItems[0], 'cheese-garden-copy')
    const entries = buildTimelineEntries([...baseItems, duplicate])

    expect(duplicate).toMatchObject({
      id: 'cheese-garden-copy',
      generated: false,
      sourceItemId: '',
      substituteGroupId: '',
      substituteOfItemId: '',
    })
    expect(entries.find((entry) => entry.item.id === duplicate.id)).toMatchObject({
      type: 'item',
      item: { id: duplicate.id },
    })
    expect(entries.find((entry) => entry.stackKind === 'substitute')?.items).toHaveLength(2)
  })
})
