// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { FieldPath } from 'firebase-admin/firestore'
import { writeTripState } from '../server/tripState'
import { sanitizeTripSnapshot } from '../src/utils/tripSchema'
import { getExpectedTripPatchState } from '../src/utils/tripValidation'

// In-memory transaction double: no app, credentials, emulator, or network.
function database(state, role = 'editor') {
  const records = new Map([
    ['trips/trip', { title: 'Synthetic trip', city: '', startDate: '2026-10-02', endDate: '2026-10-02', ownerId: 'owner', createdBy: 'owner', hidden: false }],
    ['trips/trip/members/editor', { role }],
    ['trips/trip/overrides/shared', state],
  ])
  const ref = path => ({ path, collection: name => ref(`${path}/${name}`), doc: id => ref(`${path}/${id}`) })
  const transaction = {
    get: vi.fn(async reference => ({ exists: records.has(reference.path), data: () => records.get(reference.path) })),
    update: vi.fn(), create: vi.fn(), set: vi.fn(),
  }
  return { db: { doc: ref, runTransaction: callback => callback(transaction) }, transaction }
}
function legacyState() {
  return {
    days: { day: { id: 'day', date: '2026-10-02', order: '0', name: null, legacyColor: 'blue' } },
    items: { stop: { id: 'stop', dayId: 'day', title: 'Original', description: null, durationMinutes: '30', legacyDetails: { imported: true, labels: ['keep'] } } },
    bookingOptions: {},
    revision: 4,
  }
}
function requestFor(state, patch) {
  return { action: 'patch', tripId: 'trip', operationId: 'op', patch, expectedCurrent: getExpectedTripPatchState(sanitizeTripSnapshot(state).data, patch) }
}

it('saves a supported edit while preserving extra legacy fields and untouched records', async () => {
  const state = legacyState()
  const original = structuredClone(state)
  const { db, transaction } = database(state)
  const patch = { items: { stop: { title: 'Edited' } } }
  await expect(writeTripState(db, { uid: 'editor' }, requestFor(state, patch))).resolves.toEqual({ revision: 5 })
  expect(transaction.update).toHaveBeenCalledTimes(1)
  const [reference, updatedPath, updatedAt, revisionPath, revision, itemPath, item] = transaction.update.mock.calls[0]
  expect(reference.path).toBe('trips/trip/overrides/shared')
  expect(updatedPath.isEqual(new FieldPath('updatedAt'))).toBe(true)
  expect(revisionPath.isEqual(new FieldPath('revision'))).toBe(true)
  expect(revision).toBe(5)
  expect(itemPath.isEqual(new FieldPath('items', 'stop'))).toBe(true)
  expect(item).toEqual({ ...state.items.stop, title: 'Edited', description: '', durationMinutes: 30, updatedAt })
  expect(item.legacyDetails).toEqual(original.items.stop.legacyDetails)
  expect(state).toEqual(original)
  expect(transaction.create).toHaveBeenCalledTimes(1)
})

it('does not allow the client to add or change unsupported legacy fields', async () => {
  const state = legacyState()
  const { db, transaction } = database(state)
  const patch = { items: { stop: { legacyDetails: { imported: false } } } }
  await expect(writeTripState(db, { uid: 'editor' }, requestFor(state, patch))).rejects.toThrow('Invalid items.legacyDetails')
  expect(transaction.update).not.toHaveBeenCalled()
  expect(transaction.create).not.toHaveBeenCalled()
})

it('allows editing an active stop without rewriting hidden historical categories', async () => {
  const state = legacyState()
  state.items.archivedShop = { id: 'archivedShop', category: 'Shopping', hidden: true }
  state.items.archivedEvent = { id: 'archivedEvent', category: 'Wedding', hidden: true }
  const original = structuredClone(state)
  const { db, transaction } = database(state)
  const patch = { items: { stop: { title: 'Edited active stop' } } }
  await expect(writeTripState(db, { uid: 'editor' }, requestFor(state, patch))).resolves.toEqual({ revision: 5 })
  expect(transaction.update).toHaveBeenCalledTimes(1)
  const updates = transaction.update.mock.calls[0]
  expect(updates).toHaveLength(7)
  expect(updates[5].isEqual(new FieldPath('items', 'stop'))).toBe(true)
  expect(updates[6].title).toBe('Edited active stop')
  expect(state).toEqual(original)
})

it('still rejects stale drafts after normalizing stored legacy fields', async () => {
  const state = legacyState()
  const patch = { items: { stop: { title: 'Old draft' } } }
  const request = requestFor(state, patch)
  const { db, transaction } = database({ ...state, items: { stop: { ...state.items.stop, title: 'Collaborator edit' } } })
  await expect(writeTripState(db, { uid: 'editor' }, request)).rejects.toMatchObject({ code: 'trip-version-conflict' })
  expect(transaction.update).not.toHaveBeenCalled()
})

it('keeps authorization checks for legacy trips', async () => {
  const state = legacyState()
  const { db, transaction } = database(state, 'viewer')
  await expect(writeTripState(db, { uid: 'editor' }, requestFor(state, { items: { stop: { title: 'Edit' } } }))).rejects.toMatchObject({ status: 403 })
  expect(transaction.update).not.toHaveBeenCalled()
})
