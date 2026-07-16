export function createKeyedTaskQueue() {
  const queues = new Map()
  const states = new Map()

  return {
    enqueue(key, task, fallbackState) {
      if (!key) return Promise.reject(new Error('A queue key is required.'))

      const previous = queues.get(key) || Promise.resolve()
      const pending = previous.then(async () => {
        const currentState = states.has(key) ? states.get(key) : fallbackState
        const nextState = await task(currentState)
        if (nextState !== undefined) states.set(key, nextState)
        return nextState
      })
      const settled = pending.catch(() => undefined)
      queues.set(key, settled)
      settled.finally(() => {
        if (queues.get(key) === settled) queues.delete(key)
      })
      return pending
    },

    getState(key, fallbackState) {
      return states.has(key) ? states.get(key) : fallbackState
    },

    setState(key, state) {
      if (key) states.set(key, state)
    },
  }
}
