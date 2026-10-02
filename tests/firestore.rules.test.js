// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { writeTripState } from '../server/tripState'
import { getExpectedTripPatchState } from '../src/utils/tripValidation'

const projectId = 'trip-planner-rules-test'
let testEnv, adminApp, adminDb

const ownerToken = {
  email: 'owner@example.com',
  name: 'Owner',
  picture: 'https://example.com/owner.png',
}
const editorToken = {
  email: 'editor@example.com',
  name: 'Editor',
  picture: 'https://example.com/editor.png',
}
const viewerToken = {
  email: 'viewer@example.com',
  name: 'Viewer',
  picture: 'https://example.com/viewer.png',
}

function tripMeta(title = 'Trip') {
  return {
    title,
    startDate: '2026-07-16',
    endDate: '2026-07-17',
    city: 'Tokyo',
    ownerId: 'owner',
    createdBy: 'owner',
    isDemo: false,
    hidden: false,
  }
}

function membership(uid, role, title = 'Trip') {
  return {
    tripId: 'trip-one',
    role,
    title,
    startDate: '2026-07-16',
    endDate: '2026-07-17',
    city: 'Tokyo',
    isDemo: false,
    hidden: false,
    ownerId: 'owner',
    createdBy: 'owner',
    updatedAt: new Date(),
    uid,
  }
}

function invitePayload(inviteId, overrides = {}) {
  return {
    inviteId,
    tripId: 'trip-one',
    role: 'viewer',
    title: 'Trip',
    startDate: '2026-07-16',
    endDate: '2026-07-17',
    city: 'Tokyo',
    isDemo: false,
    hidden: false,
    active: true,
    ownerId: 'owner',
    createdBy: 'owner',
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    maxUses: 1,
    useCount: 0,
    ...overrides,
  }
}

function acceptedMember(uid, token, inviteId, role = 'viewer') {
  return {
    uid,
    email: token.email,
    displayName: token.name,
    photoURL: token.picture,
    role,
    invitedBy: 'owner',
    inviteId,
    joinedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
}

function queueInviteAcceptance(db, inviteId, uid, token, role = 'viewer') {
  const batch = writeBatch(db)
  batch.set(
    doc(db, `tripInvites/${inviteId}`),
    {
      active: false,
      lastUsedAt: serverTimestamp(),
      lastUsedBy: uid,
      updatedAt: serverTimestamp(),
      useCount: 1,
    },
    { merge: true },
  )
  batch.set(
    doc(db, `trips/trip-one/members/${uid}`),
    acceptedMember(uid, token, inviteId, role),
  )
  const index = membership(uid, role)
  delete index.uid
  index.updatedAt = serverTimestamp()
  batch.set(doc(db, `users/${uid}/tripMemberships/trip-one`), index)
  return batch
}

function acceptInviteLikeClient(db, inviteId, uid, token, role = 'viewer') {
  return runTransaction(db, async (transaction) => {
    const inviteRef = doc(db, `tripInvites/${inviteId}`)
    const memberRef = doc(db, `trips/trip-one/members/${uid}`)
    const membershipIndexRef = doc(db, `users/${uid}/tripMemberships/trip-one`)
    const invite = await transaction.get(inviteRef)
    const existingMembership = await transaction.get(membershipIndexRef)

    if (!invite.exists()) throw new Error('Invitation link was not found.')
    if (existingMembership.exists()) return

    transaction.set(
      inviteRef,
      {
        active: false,
        lastUsedAt: serverTimestamp(),
        lastUsedBy: uid,
        updatedAt: serverTimestamp(),
        useCount: 1,
      },
      { merge: true },
    )
    transaction.set(memberRef, acceptedMember(uid, token, inviteId, role))
    const index = membership(uid, role)
    delete index.uid
    index.updatedAt = serverTimestamp()
    transaction.set(membershipIndexRef, index, { merge: true })
  })
}

async function seedTrip() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, 'trips/trip-one'), tripMeta())
    await setDoc(doc(db, 'trips/trip-one/members/owner'), { uid: 'owner', role: 'owner' })
  })
}

beforeAll(async () => {
  adminApp = initializeApp({ projectId }, 'trip-rules-admin')
  adminDb = getFirestore(adminApp)
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(resolve('firestore.rules'), 'utf8') },
  })
})

beforeEach(async () => testEnv.clearFirestore())
afterAll(async () => { await testEnv.cleanup(); await deleteApp(adminApp) })

async function patchAsOwner(current, patch, operationId = crypto.randomUUID()) {
  return writeTripState(adminDb, { uid: 'owner', ...ownerToken }, { action: 'patch', tripId: 'trip-one', operationId, patch, expectedCurrent: getExpectedTripPatchState(current, patch) })
}

describe('Firestore itinerary patch preservation', () => {
  it('keeps other days, events and bookings when deleting an empty day', async () => {
      await seedTrip()
      const db = testEnv.authenticatedContext('owner', ownerToken).firestore()
      const reference = doc(db, 'trips/trip-one/overrides/shared')
      const original = {
        days: {
          first: { id: 'first', date: '2030-01-01', order: 0 },
          last: { id: 'last', date: '2030-01-02', order: 1 },
        },
        items: {
          event: { id: 'event', dayId: 'first', title: 'Keep this event', bookingRef: 'TEST' },
        },
        bookingOptions: {
          booking: { id: 'booking', dayId: 'first', linkedItemId: 'event', notes: 'Keep this booking' },
        },
      }
      await adminDb.doc(reference.path).set(original)
      const patch = {
        days: { first: { order: 0 }, last: { hidden: true } },
        items: {},
        bookingOptions: {},
      }
      await patchAsOwner(original, patch)
      const saved = (await getDoc(reference)).data()
      expect(saved.items).toEqual(original.items)
      expect(saved.bookingOptions).toEqual(original.bookingOptions)
      expect(saved.days.first).toMatchObject(original.days.first)
      expect(saved.days.first.hidden).toBeUndefined()
      expect(saved.days.last).toMatchObject({ ...original.days.last, hidden: true })
    },
  )

  it('hides only targeted records when the deleted day has events and bookings', async () => {
    await seedTrip()
    const db = testEnv.authenticatedContext('owner', ownerToken).firestore()
    const reference = doc(db, 'trips/trip-one/overrides/shared')
    const original = {
      days: {
        first: { id: 'first', date: '2030-01-01', order: 0 },
        last: { id: 'last', date: '2030-01-02', order: 1 },
      },
      items: {
        keep: { id: 'keep', dayId: 'first', title: 'Keep this event' },
        remove: { id: 'remove', dayId: 'last', title: 'Remove this event' },
      },
      bookingOptions: {
        keep: { id: 'keep', dayId: 'first' },
        remove: { id: 'remove', dayId: 'last' },
      },
    }
    await adminDb.doc(reference.path).set(original)
    await patchAsOwner(original, {
      days: { first: { order: 0 }, last: { hidden: true } },
      items: { remove: { hidden: true } },
      bookingOptions: { remove: { hidden: true } },
    })
    const saved = (await getDoc(reference)).data()
    expect(saved.items.keep).toEqual(original.items.keep)
    expect(saved.bookingOptions.keep).toEqual(original.bookingOptions.keep)
    expect(saved.items.remove).toMatchObject({ ...original.items.remove, hidden: true })
    expect(saved.bookingOptions.remove).toMatchObject({ ...original.bookingOptions.remove, hidden: true })
  })
})

describe('Firestore authorization', () => {
  it('rejects spoofed invite identity and direct writes that bypass itinerary validation', async () => {
    await seedTrip()
    await adminDb.doc('tripInvites/identity-link').set(invitePayload('identity-link'))
    const viewerDb = testEnv.authenticatedContext('viewer', viewerToken).firestore()
    await assertFails(queueInviteAcceptance(viewerDb, 'identity-link', 'viewer', ownerToken).commit())
    await assertSucceeds(queueInviteAcceptance(viewerDb, 'identity-link', 'viewer', viewerToken).commit())
    const ownerDb = testEnv.authenticatedContext('owner', ownerToken).firestore()
    await assertFails(setDoc(doc(ownerDb, 'trips/trip-one/overrides/shared'), { items: { bad: { startTime: 42 } } }))
    await assertFails(setDoc(doc(viewerDb, 'trips/trip-one/overrides/shared'), { items: {} }))
  })

  it('blocks removed members from old links and permits an explicit manager re-add with verified identity', async () => {
    await seedTrip()
    await adminDb.doc('tripInvites/old-link').set(invitePayload('old-link'))
    await adminDb.doc('trips/trip-one/members/viewer').set({ uid: 'viewer', role: 'viewer' })
    await adminDb.doc('users/viewer').set({ uid: 'viewer', email: viewerToken.email, displayName: viewerToken.name, photoURL: viewerToken.picture })
    const ownerDb = testEnv.authenticatedContext('owner', ownerToken).firestore()
    const viewerDb = testEnv.authenticatedContext('viewer', viewerToken).firestore()
    const remove = writeBatch(ownerDb)
    remove.set(doc(ownerDb, 'trips/trip-one/removedMembers/viewer'), { uid: 'viewer', removedBy: 'owner', removedAt: serverTimestamp() })
    remove.delete(doc(ownerDb, 'trips/trip-one/members/viewer'))
    await assertSucceeds(remove.commit())
    await assertFails(queueInviteAcceptance(viewerDb, 'old-link', 'viewer', viewerToken).commit())
    const spoofed = writeBatch(ownerDb)
    spoofed.delete(doc(ownerDb, 'trips/trip-one/removedMembers/viewer'))
    spoofed.set(doc(ownerDb, 'trips/trip-one/members/viewer'), acceptedMember('viewer', ownerToken, 'old-link'))
    await assertFails(spoofed.commit())
    const readd = writeBatch(ownerDb)
    readd.delete(doc(ownerDb, 'trips/trip-one/removedMembers/viewer'))
    readd.set(doc(ownerDb, 'trips/trip-one/members/viewer'), acceptedMember('viewer', viewerToken, 'old-link'))
    await assertSucceeds(readd.commit())
    expect((await getDoc(doc(ownerDb, 'trips/trip-one/members/viewer'))).data().email).toBe(viewerToken.email)
  })
  it('keeps profiles private and binds identity fields to auth claims', async () => {
    const ownerDb = testEnv.authenticatedContext('owner', ownerToken).firestore()
    const editorDb = testEnv.authenticatedContext('editor', editorToken).firestore()
    const profile = {
      uid: 'owner',
      ...ownerToken,
      displayName: ownerToken.name,
      photoURL: ownerToken.picture,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    delete profile.name
    delete profile.picture

    await assertSucceeds(setDoc(doc(ownerDb, 'users/owner'), profile))
    await assertFails(getDoc(doc(editorDb, 'users/owner')))
    await assertFails(setDoc(doc(ownerDb, 'users/owner'), { ...profile, email: 'spoof@example.com' }))
  })

  it('allows an editor to mirror an authorized trip rename without changing roles', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()
      await setDoc(doc(db, 'trips/trip-one'), tripMeta())
      await setDoc(doc(db, 'trips/trip-one/members/owner'), { uid: 'owner', role: 'owner' })
      await setDoc(doc(db, 'trips/trip-one/members/editor'), { uid: 'editor', role: 'editor' })
      const ownerIndex = membership('owner', 'owner')
      delete ownerIndex.uid
      await setDoc(doc(db, 'users/owner/tripMemberships/trip-one'), ownerIndex)
    })

    const editorDb = testEnv.authenticatedContext('editor', editorToken).firestore()
    const batch = writeBatch(editorDb)
    batch.set(doc(editorDb, 'trips/trip-one'), tripMeta('Renamed'), { merge: true })
    const mirrored = membership('owner', 'owner', 'Renamed')
    delete mirrored.uid
    batch.set(doc(editorDb, 'users/owner/tripMemberships/trip-one'), mirrored)
    await assertSucceeds(batch.commit())

    await assertFails(
      setDoc(
        doc(editorDb, 'users/owner/tripMemberships/trip-one'),
        { ...mirrored, role: 'editor' },
      ),
    )
  })

  it('creates bounded links, lists them for managers, and consumes a use atomically', async () => {
    await seedTrip()
    const ownerDb = testEnv.authenticatedContext('owner', ownerToken).firestore()
    const viewerDb = testEnv.authenticatedContext('viewer', viewerToken).firestore()
    const inviteId = 'invite-bounded'

    await assertSucceeds(
      setDoc(doc(ownerDb, `tripInvites/${inviteId}`), {
        ...invitePayload(inviteId),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
    await assertSucceeds(
      getDocs(query(collection(ownerDb, 'tripInvites'), where('tripId', '==', 'trip-one'))),
    )

    await assertSucceeds(
      acceptInviteLikeClient(viewerDb, inviteId, 'viewer', viewerToken),
    )
    const consumed = await getDoc(doc(ownerDb, `tripInvites/${inviteId}`))
    expect(consumed.data()).toMatchObject({ active: false, useCount: 1, lastUsedBy: 'viewer' })

    const secondDb = testEnv.authenticatedContext('second-viewer', {
      email: 'second@example.com',
      name: 'Second Viewer',
      picture: '',
    }).firestore()
    await assertFails(
      queueInviteAcceptance(
        secondDb,
        inviteId,
        'second-viewer',
        { email: 'second@example.com', name: 'Second Viewer', picture: '' },
      ).commit(),
    )
  })

  it('rejects expired and revoked invitation links', async () => {
    await seedTrip()
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()
      await setDoc(
        doc(db, 'tripInvites/invite-expired'),
        invitePayload('invite-expired', { expiresAt: new Date(Date.now() - 60_000) }),
      )
      await setDoc(doc(db, 'tripInvites/invite-revoked'), invitePayload('invite-revoked'))
    })

    const ownerDb = testEnv.authenticatedContext('owner', ownerToken).firestore()
    await assertSucceeds(
      setDoc(
        doc(ownerDb, 'tripInvites/invite-revoked'),
        {
          active: false,
          revokedAt: serverTimestamp(),
          revokedBy: 'owner',
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      ),
    )

    const viewerDb = testEnv.authenticatedContext('viewer', viewerToken).firestore()
    await assertFails(
      queueInviteAcceptance(viewerDb, 'invite-expired', 'viewer', viewerToken).commit(),
    )
    await assertFails(
      queueInviteAcceptance(viewerDb, 'invite-revoked', 'viewer', viewerToken).commit(),
    )
  })

  it('invalidates a link when its creator is no longer a manager', async () => {
    await seedTrip()
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore()
      await setDoc(doc(db, 'trips/trip-one/members/editor'), { uid: 'editor', role: 'editor' })
      await setDoc(
        doc(db, 'tripInvites/invite-stale-manager'),
        invitePayload('invite-stale-manager', { createdBy: 'editor' }),
      )
    })

    const viewerDb = testEnv.authenticatedContext('viewer', viewerToken).firestore()
    await assertFails(
      queueInviteAcceptance(
        viewerDb,
        'invite-stale-manager',
        'viewer',
        viewerToken,
      ).commit(),
    )
  })
})

describe('authenticated itinerary transactions', () => {
  const initial = {
    days: { first: { id: 'first', date: '2026-10-02', order: 0 } },
    items: { stop: { id: 'stop', dayId: 'first', title: 'Original', startTime: '10:00' } },
    bookingOptions: {},
  }
  beforeEach(async () => {
    await seedTrip()
    await adminDb.doc('trips/trip-one/overrides/shared').set(initial)
  })

  it('rejects stale drafts, allows unrelated edits, and makes commit retries idempotent', async () => {
    const patch = { items: { stop: { title: 'Collaborator edit' } } }
    const op = crypto.randomUUID()
    expect(await patchAsOwner(initial, patch, op)).toEqual({ revision: 1 })
    expect(await patchAsOwner(initial, patch, op)).toEqual({ revision: 1 })
    await expect(patchAsOwner(initial, { items: { stop: { title: 'Stale draft' } } })).rejects.toMatchObject({ code: 'trip-version-conflict' })
    await expect(patchAsOwner(initial, { items: { another: { title: 'Independent stop' } } })).resolves.toEqual({ revision: 2 })
    const state = (await adminDb.doc('trips/trip-one/overrides/shared').get()).data()
    expect(state.items.stop.title).toBe('Collaborator edit')
    expect(state.items.another.title).toBe('Independent stop')
    expect((await adminDb.collection('trips/trip-one/writeReceipts').get()).size).toBe(2)
  })

  it('checks actual membership even on retries and rejects invalid nested data', async () => {
    const patch = { items: { stop: { title: 'Saved' } } }
    const op = crypto.randomUUID()
    await patchAsOwner(initial, patch, op)
    await adminDb.doc('trips/trip-one/members/owner').update({ role: 'viewer' })
    await expect(patchAsOwner(initial, patch, op)).rejects.toMatchObject({ status: 403 })
    await adminDb.doc('trips/trip-one/members/owner').update({ role: 'owner' })
    await expect(patchAsOwner(initial, { items: { malformed: { startTime: 42 } } })).rejects.toMatchObject({ status: 400 })
    await expect(writeTripState(adminDb, { uid: 'outsider' }, { action: 'patch', tripId: 'trip-one', operationId: crypto.randomUUID(), patch, expectedCurrent: {} })).rejects.toMatchObject({ status: 403 })
  })

  it('updates metadata and every membership date atomically with a day change', async () => {
    await adminDb.doc('trips/trip-one/members/viewer').set({ uid: 'viewer', role: 'viewer' })
    await patchAsOwner(initial, { days: { second: { date: '2026-09-01', order: 1 } } })
    for (const path of ['trips/trip-one', 'users/owner/tripMemberships/trip-one', 'users/viewer/tripMemberships/trip-one']) {
      expect((await adminDb.doc(path).get()).data()).toMatchObject({ startDate: '2026-09-01', endDate: '2026-10-02' })
    }
  })

  it('renames without copying stale dates and checks owner-only metadata changes', async () => {
    await patchAsOwner(initial, { days: { second: { date: '2026-12-01', order: 1 } } })
    const rename = { action: 'metadata', tripId: 'trip-one', operationId: crypto.randomUUID(), payload: { title: 'Renamed' } }
    await writeTripState(adminDb, { uid: 'owner' }, rename)
    expect((await adminDb.doc('users/owner/tripMemberships/trip-one').get()).data()).toMatchObject({ title: 'Renamed', startDate: '2026-10-02', endDate: '2026-12-01' })
    await adminDb.doc('trips/trip-one/members/editor').set({ uid: 'editor', role: 'editor' })
    await expect(writeTripState(adminDb, { uid: 'editor' }, { ...rename, operationId: crypto.randomUUID(), payload: { hidden: true } })).rejects.toMatchObject({ status: 403 })
  })

  it('creates a trip with token-bound owner identity and validates its contents', async () => {
    const request = { action: 'create', tripId: 'new-trip', operationId: crypto.randomUUID(), payload: { title: 'New trip', city: 'Tokyo', ...initial } }
    const actor = { uid: 'creator', ...viewerToken }
    await expect(writeTripState(adminDb, actor, request)).resolves.toEqual({ revision: 1 })
    await expect(writeTripState(adminDb, actor, request)).resolves.toEqual({ revision: 1 })
    expect((await adminDb.doc('trips/new-trip/members/creator').get()).data()).toMatchObject({ uid: 'creator', email: viewerToken.email, displayName: viewerToken.name, role: 'owner' })
    await expect(writeTripState(adminDb, actor, { ...request, tripId: 'bad-trip', payload: { ...request.payload, items: { bad: { title: {} } } } })).rejects.toMatchObject({ status: 400 })
    expect((await adminDb.doc('trips/bad-trip').get()).exists).toBe(false)
  })
})
