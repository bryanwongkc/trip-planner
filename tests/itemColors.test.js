import { describe, expect, it } from 'vitest'
import { assignItineraryItemColors, getItineraryItemColor } from '../src/utils/itemColors'

describe('itinerary item colors', () => {
  it('assigns a different color to every item in the same day', () => {
    const assignments = assignItineraryItemColors(
      Array.from({ length: 18 }, (_, index) => ({
        id: `item-${index + 1}`,
        dayId: 'day-1',
      })),
    )

    expect(new Set(assignments.map((assignment) => assignment.color.solid))).toHaveLength(18)
  })

  it('resets the palette for each day and stays deterministic', () => {
    const assignments = assignItineraryItemColors([
      { id: 'day-1-a', dayId: 'day-1' },
      { id: 'day-1-b', dayId: 'day-1' },
      { id: 'day-2-a', dayId: 'day-2' },
    ])

    expect(assignments[0].color).toEqual(getItineraryItemColor(0))
    expect(assignments[1].color).toEqual(getItineraryItemColor(1))
    expect(assignments[2].color).toEqual(assignments[0].color)
  })
})
