export function createAsyncTtlCache({ now = () => Date.now() } = {}) {
  const entries = new Map()

  return {
    async get(key, { load, ttlMs }) {
      if (!key || typeof load !== 'function') return null

      const currentTime = now()
      const existing = entries.get(key)
      if (existing?.promise) return existing.promise
      if (existing && currentTime - existing.storedAt < ttlMs) return existing.value

      const promise = Promise.resolve()
        .then(load)
        .then(
          (value) => {
            entries.set(key, { storedAt: now(), value })
            return value
          },
          (error) => {
            if (entries.get(key)?.promise === promise) entries.delete(key)
            throw error
          },
        )

      entries.set(key, { promise, storedAt: currentTime })
      return promise
    },

    delete(key) {
      entries.delete(key)
    },
  }
}
