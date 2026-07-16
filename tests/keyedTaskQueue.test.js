import { describe, expect, it } from 'vitest'
import { createKeyedTaskQueue } from '../src/utils/keyedTaskQueue'

describe('keyed task queue', () => {
  it('serializes one trip while allowing another trip to save independently', async () => {
    const queue = createKeyedTaskQueue()
    queue.setState('trip-a', { items: ['a'] })
    queue.setState('trip-b', { items: ['b'] })

    let releaseTripA
    const tripABlocked = new Promise((resolve) => {
      releaseTripA = resolve
    })
    const firstA = queue.enqueue('trip-a', async (state) => {
      await tripABlocked
      return { items: [...state.items, 'a2'] }
    })
    const tripB = queue.enqueue('trip-b', async (state) => ({ items: [...state.items, 'b2'] }))

    await expect(tripB).resolves.toEqual({ items: ['b', 'b2'] })
    expect(queue.getState('trip-b')).toEqual({ items: ['b', 'b2'] })
    expect(queue.getState('trip-a')).toEqual({ items: ['a'] })

    releaseTripA()
    await expect(firstA).resolves.toEqual({ items: ['a', 'a2'] })
    expect(queue.getState('trip-a')).toEqual({ items: ['a', 'a2'] })
  })

  it('passes the result of one trip save to the next save for that trip', async () => {
    const queue = createKeyedTaskQueue()
    queue.setState('trip-a', { count: 0 })

    const first = queue.enqueue('trip-a', async (state) => ({ count: state.count + 1 }))
    const second = queue.enqueue('trip-a', async (state) => ({ count: state.count + 1 }))

    await Promise.all([first, second])
    expect(queue.getState('trip-a')).toEqual({ count: 2 })
  })
})
