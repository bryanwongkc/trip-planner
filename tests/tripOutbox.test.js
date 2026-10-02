import { describe, expect, it, vi } from 'vitest'
import { createTripOutbox } from '../src/utils/tripOutbox'

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key: i => [...values.keys()][i],
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}
const patch = title => ({ items: { stop: { id: 'stop', title } } })

describe('durable trip outbox', () => {
  it('recovers every offline save across reload and retires it only after the server snapshot', async () => {
    const storage = memoryStorage()
    const send = vi.fn(async () => ({ revision: send.mock.calls.length }))
    const offline = createTripOutbox({ storage, send, isOnline: () => false })
    await offline.start('alice')
    offline.enqueue('alice', 'trip', patch('First'), { items: { stop: null } })
    offline.enqueue('alice', 'trip', patch('Second'), patch('First'))
    expect(send).not.toHaveBeenCalled()
    const reloaded = createTripOutbox({ storage, send })
    expect(reloaded.overlay('alice', 'trip', {}).items.stop.title).toBe('Second')
    await reloaded.start('alice')
    expect(send).toHaveBeenCalledTimes(2)
    expect(reloaded.list('alice', 'trip')).toHaveLength(2)
    reloaded.acknowledge('alice', 'trip', 1)
    expect(reloaded.list('alice', 'trip')).toHaveLength(1)
    reloaded.acknowledge('alice', 'trip', 2)
    expect(reloaded.list('alice', 'trip')).toEqual([])
  })

  it('stores a second edit immediately while the first request is still waiting', async () => {
    const storage = memoryStorage()
    let reply
    const send = vi.fn(() => new Promise(resolve => { reply = resolve }))
    const queue = createTripOutbox({ storage, send })
    await queue.start('alice')
    queue.enqueue('alice', 'trip', patch('First'), {})
    queue.enqueue('alice', 'trip', patch('Second'), {})
    expect(createTripOutbox({ storage, send }).list('alice')).toHaveLength(2)
    reply({ revision: 1 })
    await queue.flush()
    expect(queue.list('alice')).toHaveLength(2)
  })

  it('retains a rejected edit and its tail, syncs other trips, and never sends another account’s writes', async () => {
    const storage = memoryStorage()
    const queue = createTripOutbox({ storage, send: async (_uid, entry) => {
      if (entry.tripId === 'conflict') throw Object.assign(new Error('Changed elsewhere'), { status: 409 })
      return { revision: 1 }
    } })
    queue.enqueue('alice', 'conflict', patch('First'), {})
    queue.enqueue('alice', 'conflict', patch('Second'), {})
    queue.enqueue('alice', 'other', patch('Other trip'), {})
    queue.enqueue('bob', 'private', patch('Bob’s trip'), {})
    await queue.start('alice')
    expect(queue.list('alice', 'conflict').map(e => e.status)).toEqual(['blocked', 'pending'])
    expect(queue.list('alice', 'other')[0].status).toBe('sent')
    expect(queue.list('bob')[0].status).toBe('pending')
    expect(queue.overlay('alice', 'conflict', {}).items.stop.title).toBe('Second')
    queue.discard('alice', 'conflict')
    expect(queue.list('alice', 'conflict')).toEqual([])
  })

  it('does not claim a save succeeded when device storage is full', () => {
    const storage = memoryStorage()
    storage.setItem = () => { throw new Error('Quota exceeded') }
    const send = vi.fn()
    const queue = createTripOutbox({ storage, send })
    expect(() => queue.enqueue('alice', 'trip', patch('Lost'), {})).toThrow('could not store')
    expect(send).not.toHaveBeenCalled()
  })
})
