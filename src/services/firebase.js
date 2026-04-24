const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const firebaseEnabled = Object.values(firebaseConfig).every(Boolean)

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

      return {
        GoogleAuthProvider: authModule.GoogleAuthProvider,
        auth: authModule.getAuth(app),
        collection: firestoreModule.collection,
        db: firestoreModule.getFirestore(app),
        deleteDoc: firestoreModule.deleteDoc,
        doc: firestoreModule.doc,
        getDoc: firestoreModule.getDoc,
        getDocs: firestoreModule.getDocs,
        limit: firestoreModule.limit,
        onAuthStateChanged: authModule.onAuthStateChanged,
        onSnapshot: firestoreModule.onSnapshot,
        query: firestoreModule.query,
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
    hidden: Boolean(tripMeta?.hidden),
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

export async function lookupUserByEmail(email) {
  const { collection, db, getDocs, limit, query, where } = await loadFirebaseServices()
  if (!db || !email) return null

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null

  const usersQuery = query(collection(db, 'users'), where('email', '==', normalizedEmail), limit(1))
  const snapshot = await getDocs(usersQuery)
  const match = snapshot.docs[0]
  return match ? { id: match.id, ...match.data() } : null
}

export async function mergeTripPatch(tripId, patch) {
  const { db, doc, serverTimestamp, setDoc } = await loadFirebaseServices()
  if (!db || !tripId) return

  const overridesDoc = doc(db, 'trips', tripId, 'overrides', 'shared')
  const payload = {
    updatedAt: serverTimestamp(),
  }

  if (patch.days) {
    payload.days = stampEntityMap(patch.days, serverTimestamp)
  }

  if (patch.items) {
    payload.items = stampEntityMap(patch.items, serverTimestamp)
  }

  if (patch.bookingOptions) {
    payload.bookingOptions = stampEntityMap(patch.bookingOptions, serverTimestamp)
  }

  await setDoc(overridesDoc, payload, { merge: true })
}

export async function createTripRecordWithOwner(tripId, payload, ownerUser) {
  const { db, doc, serverTimestamp, setDoc } = await loadFirebaseServices()
  if (!db || !tripId || !ownerUser?.uid) return

  const tripDoc = doc(db, 'trips', tripId)
  const overridesDoc = doc(db, 'trips', tripId, 'overrides', 'shared')
  const memberDoc = doc(db, 'trips', tripId, 'members', ownerUser.uid)
  const membershipIndexDoc = doc(db, 'users', ownerUser.uid, 'tripMemberships', tripId)

  const tripMeta = {
    title: payload.title,
    startDate: payload.startDate,
    endDate: payload.endDate,
    ownerId: ownerUser.uid,
    createdBy: ownerUser.uid,
    hidden: false,
  }

  await setDoc(
    tripDoc,
    stripUndefined({
      ...tripMeta,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )
  await setDoc(
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
  await setDoc(
    membershipIndexDoc,
    buildTripIndexPayload(tripId, 'owner', tripMeta, serverTimestamp),
    { merge: true },
  )
  await setDoc(
    overridesDoc,
    {
      updatedAt: serverTimestamp(),
      days: stampEntityMap(payload.days, serverTimestamp),
      items: stampEntityMap(payload.items, serverTimestamp),
      bookingOptions: stampEntityMap(payload.bookingOptions, serverTimestamp),
    },
    { merge: true },
  )
}

export async function upsertTripMeta(tripId, payload) {
  const { db, doc, serverTimestamp, setDoc, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId) return

  const { tripData, memberDocs } = await getTripMetaAndMembers(tripId)
  const tripMeta = {
    title: payload.title ?? tripData?.title ?? '',
    startDate: payload.startDate ?? tripData?.startDate ?? '',
    endDate: payload.endDate ?? tripData?.endDate ?? '',
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

export async function addTripMember(tripId, actorUser, memberUser, role, tripMeta = {}) {
  const { db, doc, serverTimestamp, setDoc, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId || !memberUser?.uid) return

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
  const { db, doc, getDoc, serverTimestamp, setDoc, writeBatch } = await loadFirebaseServices()
  if (!db || !tripId || !memberUid) return

  const memberDoc = doc(db, 'trips', tripId, 'members', memberUid)
  const memberSnapshot = await getDoc(memberDoc)
  if (!memberSnapshot.exists()) return

  const memberData = memberSnapshot.data()
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
  const { db, deleteDoc, doc } = await loadFirebaseServices()
  if (!db || !tripId || !memberUid) return

  await Promise.all([
    deleteDoc(doc(db, 'trips', tripId, 'members', memberUid)),
    deleteDoc(doc(db, 'users', memberUid, 'tripMemberships', tripId)),
  ])
}
