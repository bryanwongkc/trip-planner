import { assertTripPatchIsCurrent, validateTripPatch } from '../utils/tripValidation'
import {
  normalizeTripInviteOptions,
  tripInviteStatus,
} from '../utils/tripInvites'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const firebaseEnabled =
  import.meta.env.VITE_DISABLE_FIREBASE !== 'true' && Object.values(firebaseConfig).every(Boolean)

let servicesPromise

async function loadFirebaseServices() {
  if (!firebaseEnabled) {
    return {
      GoogleAuthProvider: null,
      auth: null,
      collection: null,
      db: null,
      deleteDoc: null,
      doc: null,
      getDoc: null,
      getDocs: null,
      limit: null,
      onAuthStateChanged: null,
      onSnapshot: null,
      query: null,
      runTransaction: null,
      serverTimestamp: null,
      setDoc: null,
      signInWithPopup: null,
      signOut: null,
      where: null,
      writeBatch: null,
    }
  }

  if (!servicesPromise) {
    servicesPromise = Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]).then(([appModule, authModule, firestoreModule]) => {
      const app = appModule.getApps().length
        ? appModule.getApp()
        : appModule.initializeApp(firebaseConfig)

      let db
      try {
        db = firestoreModule.initializeFirestore(app, {
          localCache: firestoreModule.persistentLocalCache({
            tabManager: firestoreModule.persistentMultipleTabManager(),
          }),
        })
      } catch (error) {
        if (!['failed-precondition', 'unimplemented'].includes(error?.code)) throw error
        db = firestoreModule.getFirestore(app)
      }

      return {
        GoogleAuthProvider: authModule.GoogleAuthProvider,
        auth: authModule.getAuth(app),
        collection: firestoreModule.collection,
        db,
        deleteDoc: firestoreModule.deleteDoc,
        doc: firestoreModule.doc,
        getDoc: firestoreModule.getDoc,
        getDocs: firestoreModule.getDocs,
        limit: firestoreModule.limit,
        onAuthStateChanged: authModule.onAuthStateChanged,
        onSnapshot: firestoreModule.onSnapshot,
        query: firestoreModule.query,
        runTransaction: firestoreModule.runTransaction,
        serverTimestamp: firestoreModule.serverTimestamp,
        setDoc: firestoreModule.setDoc,
        signInWithPopup: authModule.signInWithPopup,
        signOut: authModule.signOut,
        where: firestoreModule.where,
        writeBatch: firestoreModule.writeBatch,
      }
    })
  }

  return servicesPromise
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  )
}

function stampEntityMap(entityMap, serverTimestamp) {
  return Object.fromEntries(
    Object.entries(entityMap || {}).map(([id, entity]) => [
      id,
      stripUndefined({
        ...entity,
        updatedAt: serverTimestamp(),
      }),
    ]),
  )
}

function serializeUserProfile(user) {
  return {
    uid: user.uid,
    displayName: user.displayName || '',
    email: user.email || '',
    photoURL: user.photoURL || '',
  }
}

function buildTripIndexPayload(tripId, role, tripMeta, serverTimestamp) {
  return stripUndefined({
    tripId,
    role,
    title: tripMeta?.title || '',
    startDate: tripMeta?.startDate || '',
    endDate: tripMeta?.endDate || '',
    city: tripMeta?.city || '',
    hidden: Boolean(tripMeta?.hidden),
    isDemo: Boolean(tripMeta?.isDemo),
    ownerId: tripMeta?.ownerId || '',
    createdBy: tripMeta?.createdBy || '',
    updatedAt: serverTimestamp(),
  })
}

async function getTripMetaAndMembers(tripId) {
  const { collection, db, doc, getDoc, getDocs } = await loadFirebaseServices()
  if (!db || !tripId) return { memberDocs: [], tripData: null, tripExists: false }

  const tripDoc = doc(db, 'trips', tripId)
  const membersCollection = collection(db, 'trips', tripId, 'members')
  const [tripSnapshot, membersSnapshot] = await Promise.all([getDoc(tripDoc), getDocs(membersCollection)])

  return {
    tripData: tripSnapshot.exists() ? tripSnapshot.data() : null,
    tripExists: tripSnapshot.exists(),
    memberDocs: membersSnapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })),
  }
}

export async function subscribeToAuthState(onValue, onError) {
  const { auth, onAuthStateChanged } = await loadFirebaseServices()
  if (!auth || !onAuthStateChanged) return () => {}
  return onAuthStateChanged(auth, onValue, onError)
}

export async function signInWithGoogle() {
  const { GoogleAuthProvider, auth, signInWithPopup } = await loadFirebaseServices()
  if (!auth || !GoogleAuthProvider || !signInWithPopup) return null

  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const credential = await signInWithPopup(auth, provider)
  await ensureUserProfile(credential.user)
  return credential.user
}

export async function signOutUser() {
  const { auth, signOut } = await loadFirebaseServices()
  if (!auth || !signOut) return
  await signOut(auth)
}

export async function getFirebaseIdToken() {
  const { auth } = await loadFirebaseServices()
  return auth?.currentUser ? auth.currentUser.getIdToken() : ''
}

export async function ensureUserProfile(user) {
  const { db, doc, getDoc, serverTimestamp, setDoc } = await loadFirebaseServices()
  if (!db || !user?.uid) return null

  const profileDoc = doc(db, 'users', user.uid)
  const existing = await getDoc(profileDoc)

  await setDoc(
    profileDoc,
    stripUndefined({
      ...serializeUserProfile(user),
      createdAt: existing.exists() ? existing.data()?.createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )

  return serializeUserProfile(user)
}

export async function subscribeToUserProfile(uid, onValue, onError) {
  const { db, doc, onSnapshot } = await loadFirebaseServices()
  if (!db || !uid) return () => {}

  return onSnapshot(
    doc(db, 'users', uid),
    (snapshot) => onValue(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null),
    onError,
  )
}

export async function subscribeToUserTripDirectory(uid, onValue, onError) {
  const { collection, db, onSnapshot } = await loadFirebaseServices()
  if (!db || !uid) return () => {}

  const membershipsCollection = collection(db, 'users', uid, 'tripMemberships')
  return onSnapshot(
    membershipsCollection,
    (snapshot) =>
      onValue(
        snapshot.docs.map((entry) => ({
          id: entry.id,
          ...entry.data(),
        })),
      ),
    onError,
  )
}

export async function subscribeToTripState(tripId, onValue, onError) {
  const { db, doc, onSnapshot } = await loadFirebaseServices()
  if (!db || !tripId) return () => {}

  const overridesDoc = doc(db, 'trips', tripId, 'overrides', 'shared')
  return onSnapshot(
    overridesDoc,
    (snapshot) => onValue(snapshot.exists() ? snapshot.data() : null),
    onError,
  )
}

export async function subscribeToTripMembers(tripId, onValue, onError) {
  const { collection, db, onSnapshot } = await loadFirebaseServices()
  if (!db || !tripId) return () => {}

  const membersCollection = collection(db, 'trips', tripId, 'members')
  return onSnapshot(
    membersCollection,
    (snapshot) =>
      onValue(
        snapshot.docs.map((entry) => ({
          id: entry.id,
          ...entry.data(),
        })),
      ),
    onError,
  )
}

export async function lookupUserByEmail(email, tripId) {
  if (!email || !tripId) return null
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null

  const token = await getFirebaseIdToken()
  if (!token) return null
  const params = new URLSearchParams({ email: normalizedEmail, tripId })
  const response = await fetch(`/api/lookup-user?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (response.status === 404) return null
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || 'User lookup failed')
  return payload ? { id: payload.uid, ...payload } : null
}

export async function subscribeToTripInvites(tripId, onValue, onError) {
  const { collection, db, onSnapshot, query, where } = await loadFirebaseServices()
  if (!db || !tripId) return () => {}

  const inviteQuery = query(collection(db, 'tripInvites'), where('tripId', '==', tripId))
  return onSnapshot(
    inviteQuery,
    (snapshot) =>
      onValue(
        snapshot.docs.map((entry) => ({
          id: entry.id,
          ...entry.data(),
        })),
      ),
    onError,
  )
}

export async function createTripInvite(tripId, actorUser, role, tripMeta = {}, options = {}) {
  const { db, doc, serverTimestamp, setDoc } = await loadFirebaseServices()
  if (!db || !tripId || !actorUser?.uid || !['admin', 'editor', 'viewer'].includes(role)) return null

  const { expiresInDays, maxUses } = normalizeTripInviteOptions(options)
  const inviteId = `invite-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`}`
  const inviteDoc = doc(db, 'tripInvites', inviteId)
  const payload = stripUndefined({
    inviteId,
    tripId,
    role,
    title: tripMeta.title || '',
    startDate: tripMeta.startDate || '',
    endDate: tripMeta.endDate || '',
    city: tripMeta.city || '',
    hidden: false,
    isDemo: Boolean(tripMeta.isDemo),
    ownerId: tripMeta.ownerId || '',
    active: true,
    expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
    maxUses,
    useCount: 0,
    createdBy: actorUser.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  await setDoc(inviteDoc, payload)
  return payload
}

export async function acceptTripInvite(inviteId, user) {
  const { db, doc, runTransaction, serverTimestamp } = await loadFirebaseServices()
  if (!db || !inviteId || !user?.uid) return null

  const inviteDoc = doc(db, 'tripInvites', inviteId)
  return runTransaction(db, async (transaction) => {
    const inviteSnapshot = await transaction.get(inviteDoc)
    if (!inviteSnapshot.exists()) throw new Error('Invitation link was not found.')

    const invite = inviteSnapshot.data()
    if (
      tripInviteStatus(invite) !== 'active' ||
      !invite.tripId ||
      !['admin', 'editor', 'viewer'].includes(invite.role)
    ) {
      throw new Error('Invitation link is no longer active.')
    }

    const memberDoc = doc(db, 'trips', invite.tripId, 'members', user.uid)
    const memberSnapshot = await transaction.get(memberDoc)
    if (memberSnapshot.exists()) return { ...invite, id: inviteId, alreadyMember: true }

    const membershipIndexDoc = doc(db, 'users', user.uid, 'tripMemberships', invite.tripId)
    const nextUseCount = Number(invite.useCount || 0) + 1

    transaction.set(
      inviteDoc,
      {
        active: nextUseCount < Number(invite.maxUses),
        lastUsedAt: serverTimestamp(),
        lastUsedBy: user.uid,
        updatedAt: serverTimestamp(),
        useCount: nextUseCount,
      },
      { merge: true },
    )
    transaction.set(
      memberDoc,
      stripUndefined({
        ...serializeUserProfile(user),
        role: invite.role,
        invitedBy: invite.createdBy || '',
        inviteId,
        joinedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    )
    transaction.set(
      membershipIndexDoc,
      buildTripIndexPayload(invite.tripId, invite.role, invite, serverTimestamp),
      { merge: true },
    )

    return {
      ...invite,
      active: nextUseCount < Number(invite.maxUses),
      id: inviteId,
      useCount: nextUseCount,
    }
  })
}

export async function revokeTripInvite(inviteId, actorUid) {
  const { db, doc, serverTimestamp, setDoc } = await loadFirebaseServices()
  if (!db || !inviteId || !actorUid) return

  await setDoc(
    doc(db, 'tripInvites', inviteId),
    {
      active: false,
      revokedAt: serverTimestamp(),
      revokedBy: actorUid,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

function buildStampedPatch(patch, serverTimestamp) {
  const payload = { updatedAt: serverTimestamp() }
  for (const key of ['days', 'items', 'bookingOptions']) {
    if (patch[key]) payload[key] = stampEntityMap(patch[key], serverTimestamp)
  }
  return payload
}

export async function mergeTripPatch(tripId, patch, { expectedCurrent } = {}) {
  const { db, doc, runTransaction, serverTimestamp, setDoc } = await loadFirebaseServices()
  if (!db || !tripId) return

  const overridesDoc = doc(db, 'trips', tripId, 'overrides', 'shared')
  const queuePatch = async () => {
    await setDoc(overridesDoc, buildStampedPatch(patch, serverTimestamp), { merge: true })
  }

  if (globalThis.navigator?.onLine === false || !runTransaction) {
    await queuePatch()
    return
  }

  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(overridesDoc)
      const current = snapshot.exists() ? snapshot.data() : {}
      assertTripPatchIsCurrent(current, patch, expectedCurrent)
      validateTripPatch(current, patch)
      transaction.set(overridesDoc, buildStampedPatch(patch, serverTimestamp), { merge: true })
    })
  } catch (error) {
    if (error?.code !== 'unavailable') throw error
    await queuePatch()
  }
}

export async function createTripRecordWithOwner(tripId, payload, ownerUser) {
  const { db, doc, serverTimestamp, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId || !ownerUser?.uid) return

  const tripDoc = doc(db, 'trips', tripId)
  const overridesDoc = doc(db, 'trips', tripId, 'overrides', 'shared')
  const memberDoc = doc(db, 'trips', tripId, 'members', ownerUser.uid)
  const membershipIndexDoc = doc(db, 'users', ownerUser.uid, 'tripMemberships', tripId)

  const tripMeta = {
    title: payload.title,
    startDate: payload.startDate,
    endDate: payload.endDate,
    city: payload.city || '',
    ownerId: ownerUser.uid,
    createdBy: ownerUser.uid,
    hidden: false,
    isDemo: Boolean(payload.isDemo),
  }

  const batch = writeBatch(db)
  batch.set(
    tripDoc,
    stripUndefined({
      ...tripMeta,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )
  batch.set(
    memberDoc,
    stripUndefined({
      ...serializeUserProfile(ownerUser),
      role: 'owner',
      invitedBy: ownerUser.uid,
      joinedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )
  batch.set(
    membershipIndexDoc,
    buildTripIndexPayload(tripId, 'owner', tripMeta, serverTimestamp),
    { merge: true },
  )
  batch.set(
    overridesDoc,
    {
      updatedAt: serverTimestamp(),
      days: stampEntityMap(payload.days, serverTimestamp),
      items: stampEntityMap(payload.items, serverTimestamp),
      bookingOptions: stampEntityMap(payload.bookingOptions, serverTimestamp),
    },
    { merge: true },
  )
  await batch.commit()
}

export async function upsertTripMeta(tripId, payload) {
  const { db, doc, serverTimestamp, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId) return

  const { tripData, memberDocs } = await getTripMetaAndMembers(tripId)
  const tripMeta = {
    title: payload.title ?? tripData?.title ?? '',
    startDate: payload.startDate ?? tripData?.startDate ?? '',
    endDate: payload.endDate ?? tripData?.endDate ?? '',
    city: payload.city ?? tripData?.city ?? '',
    ownerId: payload.ownerId ?? tripData?.ownerId,
    createdBy: payload.createdBy ?? tripData?.createdBy,
    hidden: payload.hidden ?? tripData?.hidden ?? false,
  }

  const tripDoc = doc(db, 'trips', tripId)
  const batch = writeBatch(db)
  batch.set(
    tripDoc,
    stripUndefined({
      ...payload,
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )

  memberDocs.forEach((member) => {
    const membershipIndexDoc = doc(db, 'users', member.uid, 'tripMemberships', tripId)
    batch.set(
      membershipIndexDoc,
      buildTripIndexPayload(tripId, member.role, tripMeta, serverTimestamp),
      { merge: true },
    )
  })

  await batch.commit()
}

export async function deleteTripRecord(tripId) {
  const { db, doc, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId) return

  const { memberDocs } = await getTripMetaAndMembers(tripId)
  const batch = writeBatch(db)

  batch.delete(doc(db, 'trips', tripId, 'overrides', 'shared'))
  memberDocs.forEach((member) => {
    batch.delete(doc(db, 'trips', tripId, 'members', member.uid))
    batch.delete(doc(db, 'users', member.uid, 'tripMemberships', tripId))
  })
  batch.delete(doc(db, 'trips', tripId))

  await batch.commit()
}

export async function addTripMember(tripId, actorUser, memberUser, role, tripMeta = {}) {
  const { db, doc, serverTimestamp, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId || !memberUser?.uid || !['admin', 'editor', 'viewer'].includes(role)) return

  const batch = writeBatch(db)
  const memberDoc = doc(db, 'trips', tripId, 'members', memberUser.uid)
  const membershipIndexDoc = doc(db, 'users', memberUser.uid, 'tripMemberships', tripId)

  batch.set(
    memberDoc,
    stripUndefined({
      uid: memberUser.uid,
      email: memberUser.email || '',
      displayName: memberUser.displayName || '',
      photoURL: memberUser.photoURL || '',
      role,
      invitedBy: actorUser?.uid || '',
      joinedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )
  batch.set(
    membershipIndexDoc,
    buildTripIndexPayload(tripId, role, tripMeta, serverTimestamp),
    { merge: true },
  )

  await batch.commit()
}

export async function updateTripMemberRole(tripId, memberUid, role, tripMeta = {}) {
  const { db, doc, getDoc, serverTimestamp, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId || !memberUid || !['admin', 'editor', 'viewer'].includes(role)) return

  const memberDoc = doc(db, 'trips', tripId, 'members', memberUid)
  const memberSnapshot = await getDoc(memberDoc)
  if (!memberSnapshot.exists()) return

  const memberData = memberSnapshot.data()
  if (memberData.role === 'owner') return
  const batch = writeBatch(db)
  batch.set(
    memberDoc,
    stripUndefined({
      role,
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )
  batch.set(
    doc(db, 'users', memberUid, 'tripMemberships', tripId),
    buildTripIndexPayload(tripId, role, tripMeta, serverTimestamp),
    { merge: true },
  )

  await batch.commit()
  return { id: memberUid, ...memberData, role }
}

export async function removeTripMember(tripId, memberUid) {
  const { db, doc, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId || !memberUid) return

  const batch = writeBatch(db)
  batch.delete(doc(db, 'trips', tripId, 'members', memberUid))
  batch.delete(doc(db, 'users', memberUid, 'tripMemberships', tripId))
  await batch.commit()
}
