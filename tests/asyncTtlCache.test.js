import { describe, expect, it, vi } from 'vitest'
import { createAsyncTtlCache } from '../src/utils/asyncTtlCache'

describe('async TTL cache', () => {
  it('deduplicates concurrent loads and reuses the value within the TTL', async () => {
    let currentTime = 1_000
    const cache = createAsyncTtlCache({ now: () => currentTime })
    const load = vi.fn(async () => ({ status: 'scheduled' }))

    const first = cache.get('CX101:2026-07-16', { load, ttlMs: 60_000 })
    const second = cache.get('CX101:2026-07-16', { load, ttlMs: 60_000 })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'scheduled' },
      { status: 'scheduled' },
    ])
    expect(load).toHaveBeenCalledTimes(1)

    currentTime += 30_000
    await cache.get('CX101:2026-07-16', { load, ttlMs: 60_000 })
    expect(load).toHaveBeenCalledTimes(1)

    currentTime += 31_000
    await cache.get('CX101:2026-07-16', { load, ttlMs: 60_000 })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not retain rejected loads', async () => {
    const cache = createAsyncTtlCache()
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce('ok')

    await expect(cache.get('flight', { load, ttlMs: 60_000 })).rejects.toThrow('temporary')
    await expect(cache.get('flight', { load, ttlMs: 60_000 })).resolves.toBe('ok')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
