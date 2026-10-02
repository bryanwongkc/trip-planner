import { validateTripPatch } from '../utils/tripValidation'
import { sanitizeTripSnapshot } from '../utils/tripSchema'
import { createTripOutbox } from '../utils/tripOutbox'
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
let outbox

async function postTripState(uid, body) {
  const { auth } = await loadFirebaseServices()
  if (auth?.currentUser?.uid !== uid) throw Object.assign(new Error('Sign in to synchronize your changes.'), { status: 401 })
  const token = await auth.currentUser.getIdToken()
  if (auth.currentUser?.uid !== uid) throw Object.assign(new Error('Account changed.'), { status: 401 })
  const response = await fetch('/api/trip-state', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(payload?.error || 'Your changes could not be synchronized.'), { status: response.status, code: payload?.code })
  return payload
}

function getOutbox() {
  if (!outbox) {
    outbox = createTripOutbox({
      storage: window.localStorage,
      send: (uid, entry) => postTripState(uid, { action: 'patch', tripId: entry.tripId, operationId: entry.operationId, patch: entry.patch, expectedCurrent: entry.expectedCurrent }),
      isOnline: () => navigator.onLine !== false,
      withLock: (key, work) => navigator.locks ? navigator.locks.request(key, work) : Promise.resolve().then(work),
    })
    const retry = () => { void outbox.flush().catch(() => {}) }
    window.addEventListener('online', retry)
    window.addEventListener('storage', () => { outbox.notify(); retry() })
    window.setInterval(retry, 15_000)
  }
  return outbox
}

export function discardRejectedTripChanges(uid, tripId) {
  const queue = getOutbox()
  if (queue.list(uid, tripId).some(entry => entry.status === 'blocked')) queue.discard(uid, tripId)
}


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
  return onAuthStateChanged(auth, user => {
    // Queue/storage failures belong to the trip status, not the sign-in state.
    try {
      if (user) void getOutbox().start(user.uid).catch(() => {})
      else outbox?.stop()
    } catch { /* subscribeToTripState surfaces storage errors */ }
    onValue(user)
  }, onError)
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
  outbox?.stop()
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
  const { auth, db, doc, onSnapshot } = await loadFirebaseServices()
  if (!db || !tripId || !auth.currentUser) return () => {}
  const uid = auth.currentUser.uid
  const queue = getOutbox()
  let latest
  const emit = () => {
    if (!latest || auth.currentUser?.uid !== uid) return
    try {
      const raw = latest.exists() ? latest.data() : null
      const safe = sanitizeTripSnapshot(raw)
      const entries = queue.list(uid, tripId)
      onValue(raw ? queue.overlay(uid, tripId, safe.data) : null, {
        fromCache: latest.metadata.fromCache,
        hasPendingWrites: latest.metadata.hasPendingWrites,
        pendingCount: entries.length,
        pendingError: entries.find(entry => entry.status === 'blocked')?.error || '',
        invalidCount: safe.invalidCount,
      })
    } catch (error) { onError?.(error) }
  }
  const stopQueue = queue.subscribe(emit)
  const stopSnapshot = onSnapshot(doc(db, 'trips', tripId, 'overrides', 'shared'), { includeMetadataChanges: true }, snapshot => {
    latest = snapshot
    try {
      if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) queue.acknowledge(uid, tripId, Number(snapshot.data()?.revision) || 0)
      emit()
    } catch (error) { onError?.(error) }
  }, onError)
  return () => { stopQueue(); stopSnapshot() }
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

    const membershipIndexDoc = doc(db, 'users', user.uid, 'tripMemberships', invite.tripId)
    const membershipIndexSnapshot = await transaction.get(membershipIndexDoc)
    if (membershipIndexSnapshot.exists()) {
      return {
        ...invite,
        id: inviteId,
        role: membershipIndexSnapshot.data()?.role || invite.role,
        alreadyMember: true,
      }
    }

    const memberDoc = doc(db, 'trips', invite.tripId, 'members', user.uid)
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

export function buildStampedPatch(patch, serverTimestamp) {
  const payload = { updatedAt: serverTimestamp() }
  for (const key of ['days', 'items', 'bookingOptions']) {
    // Empty maps are no-ops in mergeTripEntityMaps, but Firestore merge writes
    // replace a stored map with {}. Omit them to preserve unrelated records.
    if (Object.keys(patch[key] || {}).length > 0) {
      payload[key] = stampEntityMap(patch[key], serverTimestamp)
    }
  }
  return payload
}

export async function mergeTripPatch(tripId, patch, { expectedCurrent, current } = {}) {
  const { auth, db } = await loadFirebaseServices()
  if (!db || !tripId || !auth.currentUser) throw new Error('Sign in to save changes.')
  validateTripPatch(current || {}, patch)
  getOutbox().enqueue(auth.currentUser.uid, tripId, patch, expectedCurrent)
  return { queued: true }
}

export async function createTripRecordWithOwner(tripId, payload, ownerUser) {
  if (!tripId || !ownerUser?.uid) throw new Error('Sign in to create a trip.')
  return postTripState(ownerUser.uid, { action: 'create', tripId, operationId: crypto.randomUUID(), payload })
}

export async function upsertTripMeta(tripId, payload) {
  const { auth } = await loadFirebaseServices()
  if (!auth?.currentUser) throw new Error('Sign in to update this trip.')
  return postTripState(auth.currentUser.uid, { action: 'metadata', tripId, operationId: crypto.randomUUID(), payload })
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
  batch.delete(doc(db, 'trips', tripId, 'removedMembers', memberUser.uid))

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
  const { auth, db, doc, serverTimestamp, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId || !memberUid || !auth.currentUser) return

  const batch = writeBatch(db)
  batch.set(doc(db, 'trips', tripId, 'removedMembers', memberUid), { uid: memberUid, removedBy: auth.currentUser.uid, removedAt: serverTimestamp() })
  batch.delete(doc(db, 'trips', tripId, 'members', memberUid))
  batch.delete(doc(db, 'users', memberUid, 'tripMemberships', tripId))
  await batch.commit()
}
