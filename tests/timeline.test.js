import { describe, expect, it } from 'vitest'
import { buildRouteTimelineItems } from '../src/utils/timeline'

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
})
