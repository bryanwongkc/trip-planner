import { mergeTripEntityMaps } from './tripValidation.js'

const PREFIX = 'trip-planner-outbox-v1:'

// One key per operation avoids cross-tab read/modify/write loss. A server receipt
// makes retries idempotent, including a crash after commit but before the reply.
export function createTripOutbox({ storage, send, isOnline = () => true, withLock = (_key, work) => work(), now = Date.now, randomId = () => crypto.randomUUID() }) {
  const listeners = new Set()
  const observedRevisions = new Map()
  let activeUid = '', flushing = null, clock = 0
  const prefixFor = uid => `${PREFIX}${encodeURIComponent(uid)}:`
  const keyFor = (uid, id) => `${prefixFor(uid)}${id}`
  const emit = () => listeners.forEach(listener => listener())
  function list(uid, tripId) {
    const entries = []
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key?.startsWith(prefixFor(uid))) continue
      try {
        const entry = JSON.parse(storage.getItem(key))
        if (entry && entry.operationId && (!tripId || entry.tripId === tripId)) entries.push(entry)
      } catch { throw new Error('Saved unsent changes could not be read. Do not clear this browser’s data.') }
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId))
  }
  function put(uid, entry) {
    try { storage.setItem(keyFor(uid, entry.operationId), JSON.stringify(entry)) }
    catch { throw new Error('This device could not store your changes. Free some browser storage and try again.') }
  }
  function acknowledge(uid, tripId, revision) {
    const key = `${uid}:${tripId}`
    observedRevisions.set(key, Math.max(observedRevisions.get(key) || 0, revision || 0))
    let removed = false
    for (const entry of list(uid, tripId)) {
      if (entry.status === 'sent' && entry.revision <= observedRevisions.get(key)) {
        storage.removeItem(keyFor(uid, entry.operationId)); removed = true
      }
    }
    if (removed) emit()
  }
  async function flush() {
    if (flushing || !activeUid || !isOnline()) return flushing
    const uid = activeUid
    flushing = withLock(`trip-planner-sync:${uid}`, async () => {
      const blocked = new Set()
      for (const entry of list(uid)) {
        if (activeUid !== uid || !isOnline()) break
        if (entry.status === 'blocked') { blocked.add(entry.tripId); continue }
        if (entry.status === 'sent' || blocked.has(entry.tripId)) continue
        try {
          const result = await send(uid, entry)
          // Never recreate an operation explicitly discarded in another tab.
          if (storage.getItem(keyFor(uid, entry.operationId))) {
            put(uid, { ...entry, status: 'sent', revision: result.revision })
            acknowledge(uid, entry.tripId, observedRevisions.get(`${uid}:${entry.tripId}`) || 0)
          }
        } catch (error) {
          if ([400, 403, 404, 409, 413].includes(error.status)) {
            put(uid, { ...entry, status: 'blocked', error: error.message })
            blocked.add(entry.tripId)
          } else break // Offline, expired session, or server unavailable: retry later.
        }
        emit()
      }
    }).finally(() => { flushing = null })
    return flushing
  }
  return {
    list,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    notify: emit,
    start(uid) { activeUid = uid; return flush() },
    stop() { activeUid = '' },
    flush,
    acknowledge,
    enqueue(uid, tripId, patch, expectedCurrent) {
      const existing = list(uid)
      if (existing.length >= 500) throw new Error('Synchronize or review your unsent changes before adding more.')
      clock = Math.max(now(), clock + 1, ...existing.map(entry => entry.createdAt + 1))
      const entry = { operationId: randomId(), tripId, patch, expectedCurrent, createdAt: clock, status: 'pending' }
      put(uid, entry)
      emit()
      void flush().catch(() => {})
      return entry
    },
    overlay(uid, tripId, base) {
      return list(uid, tripId).reduce((state, entry) => mergeTripEntityMaps(state, entry.patch), base)
    },
    discard(uid, tripId) {
      for (const entry of list(uid, tripId)) {
        // An in-flight request may already have committed. Keep normal pending
        // writes until acknowledged; only discard a rejected queue and its tail.
        if (entry.status === 'sent') continue
        storage.removeItem(keyFor(uid, entry.operationId))
      }
      emit()
    },
  }
}
