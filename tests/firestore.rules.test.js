// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

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
})
