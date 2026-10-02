// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ auth: null, directory: null, states: new Map(), accept: vi.fn(), meta: vi.fn(), subscriptions: vi.fn() }))
vi.mock('../src/services/firebase.js', () => ({
  firebaseEnabled: true,
  subscribeToAuthState: async (cb) => { mock.auth = cb; return () => {} },
  subscribeToUserTripDirectory: async (uid, cb) => { mock.directory = cb; return () => {} },
  subscribeToTripState: async (id, cb, error) => { mock.states.set(id, { cb, error }); mock.subscriptions(id); return () => {} },
  subscribeToTripMembers: async () => () => {},
  subscribeToTripInvites: async () => () => {},
  ensureUserProfile: vi.fn(),
  acceptTripInvite: mock.accept,
  upsertTripMeta: mock.meta,
  discardRejectedTripChanges: vi.fn(), addTripMember: vi.fn(), createTripInvite: vi.fn(), createTripRecordWithOwner: vi.fn(), deleteTripRecord: vi.fn(),
  lookupUserByEmail: vi.fn(), mergeTripPatch: vi.fn(), removeTripMember: vi.fn(), revokeTripInvite: vi.fn(),
  signInWithGoogle: vi.fn(), signOutUser: vi.fn(), updateTripMemberRole: vi.fn(), getFirebaseIdToken: vi.fn(),
}))
import App from '../src/App.jsx'

const trip = { id: 'shared-trip', title: 'Shared family trip', role: 'viewer', ownerId: 'owner', createdBy: 'owner', startDate: '2026-10-17', endDate: '2026-10-17', city: 'Seoul', hidden: false }
const payload = { days: { d1: { id: 'd1', date: '2026-10-17', order: 0 } }, items: { i1: { id: 'i1', title: 'INVITATION_TEST_STOP', dayId: 'd1', category: 'Activity', startTime: '10:00', order: 0 } }, bookingOptions: {} }
let root, container
const flush = async (fn = () => {}) => act(async () => { await fn(); await new Promise(resolve => setTimeout(resolve, 5)) })

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.scrollTo = () => {}
  window.scrollTo = () => {}
  globalThis.ResizeObserver = class { observe() {} disconnect() {} }
  mock.states.clear()
  mock.accept.mockReset()
  mock.meta.mockReset().mockResolvedValue(undefined)
  mock.subscriptions.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => { await flush(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function signedIn() {
  await flush(() => root.render(<App />))
  await flush(() => mock.auth({ uid: 'guest-user', displayName: 'Guest', email: 'guest@example.com' }))
}

it('keeps the loaded itinerary when invite completion selects the current trip', async () => {
  window.history.replaceState({}, '', '/?invite=invite-test')
  let resolveAccept
  mock.accept.mockImplementation(() => new Promise(resolve => { resolveAccept = resolve }))
  await signedIn()
  await flush(() => mock.directory([trip]))
  await flush(() => mock.states.get(trip.id).cb(payload))
  expect(container.textContent).toContain('INVITATION_TEST_STOP')
  await flush(() => resolveAccept({ ...trip, tripId: trip.id, inviteId: 'invite-test' }))
  expect(container.textContent).toContain('INVITATION_TEST_STOP')
  expect(container.textContent).toContain('Trip added')
  expect(mock.subscriptions).toHaveBeenCalledTimes(1)
  await flush(() => mock.auth({ uid: 'guest-user', displayName: 'Guest', email: 'guest@example.com' }))
  expect(container.textContent).toContain('INVITATION_TEST_STOP')
})

it('waits for a server snapshot and never writes metadata while a viewer loads', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mock.meta.mockRejectedValue(new Error('Missing or insufficient permissions'))
  await signedIn()
  await flush(() => mock.directory([trip]))
  await flush(() => mock.states.get(trip.id).cb(null, { fromCache: true, hasPendingWrites: false }))
  expect(mock.meta).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Loading your itinerary')
  await flush(() => mock.states.get(trip.id).cb(payload, { fromCache: false }))
  expect(container.textContent).toContain('INVITATION_TEST_STOP')
})

it('hides the previous itinerary during directory fallback without copying dates', async () => {
  await signedIn()
  const other = { ...trip, id: 'other-trip', title: 'Other trip', role: 'editor', startDate: '2026-11-01', endDate: '2026-11-01' }
  await flush(() => mock.directory([{ ...trip, role: 'editor' }, other]))
  // Pick the initially selected trip explicitly through the stored selection.
  const firstId = mock.subscriptions.mock.calls[0][0]
  const firstPayload = firstId === trip.id ? payload : { ...payload, days: { d1: { id: 'd1', date: '2026-11-01', order: 0 } } }
  await flush(() => mock.states.get(firstId).cb(firstPayload))
  mock.meta.mockClear()
  const surviving = firstId === trip.id ? other : { ...trip, role: 'editor' }
  await flush(() => mock.directory([surviving]))
  expect(mock.meta).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('INVITATION_TEST_STOP')
  expect(container.textContent).toContain('Loading your itinerary')
})

it('shows compatible legacy records and enables editing without a repair warning', async () => {
  await signedIn()
  await flush(() => mock.directory([{ ...trip, role: 'editor' }]))
  const legacy = {
    ...payload,
    days: { d1: { ...payload.days.d1, order: '0', name: null } },
    items: { i1: { ...payload.items.i1, description: null, durationMinutes: '30', oldImportData: { source: 'synthetic fixture' } } },
  }
  await flush(() => mock.states.get(trip.id).cb(legacy, { fromCache: false }))
  expect(container.textContent).toContain('INVITATION_TEST_STOP')
  expect(container.textContent).not.toContain('Editing is paused')
  expect(container.textContent).not.toContain('Loading your itinerary')
  const add = container.querySelector('button[aria-label="Add stop"]')
  expect(add).not.toBeNull()
  await flush(() => add.click())
  expect(container.querySelector('button[aria-label="Close add stop form"]')).not.toBeNull()
  expect(mock.meta).not.toHaveBeenCalled()
})

it('keeps editing available when retired categories exist in hidden records', async () => {
  await signedIn()
  await flush(() => mock.directory([{ ...trip, role: 'editor' }]))
  const legacy = {
    ...payload,
    items: {
      ...payload.items,
      archivedShop: { id: 'archivedShop', dayId: 'd1', title: 'HIDDEN_SHOP', category: 'Shopping', hidden: true },
      archivedEvent: { id: 'archivedEvent', dayId: 'd1', title: 'HIDDEN_EVENT', category: 'Wedding', hidden: true },
    },
  }
  await flush(() => mock.states.get(trip.id).cb(legacy, { fromCache: false }))
  expect(container.textContent).toContain('INVITATION_TEST_STOP')
  expect(container.textContent).not.toContain('Editing is paused')
  expect(container.textContent).not.toContain('HIDDEN_SHOP')
  expect(container.textContent).not.toContain('HIDDEN_EVENT')
  await flush(() => container.querySelector('button[aria-label="Add stop"]').click())
  expect(container.querySelector('button[aria-label="Close add stop form"]')).not.toBeNull()
  expect(mock.meta).not.toHaveBeenCalled()
})
