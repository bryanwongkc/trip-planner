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

const projectId = 'trip-planner-rules-test'
let testEnv

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
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: { rules: readFileSync(resolve('firestore.rules'), 'utf8') },
  })
})

beforeEach(async () => testEnv.clearFirestore())
afterAll(async () => testEnv.cleanup())

describe('Firestore authorization', () => {
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
