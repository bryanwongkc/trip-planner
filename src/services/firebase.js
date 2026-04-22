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
      auth: null,
      collection: null,
      db: null,
      doc: null,
      onSnapshot: null,
      serverTimestamp: null,
      setDoc: null,
      signInAnonymously: null,
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
        auth: authModule.getAuth(app),
        collection: firestoreModule.collection,
        db: firestoreModule.getFirestore(app),
        doc: firestoreModule.doc,
        onSnapshot: firestoreModule.onSnapshot,
        serverTimestamp: firestoreModule.serverTimestamp,
        setDoc: firestoreModule.setDoc,
        signInAnonymously: authModule.signInAnonymously,
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

export async function ensureAnonymousAuth() {
  const { auth, signInAnonymously } = await loadFirebaseServices()

  if (!auth) return null
  if (auth.currentUser) return auth.currentUser

  const credential = await signInAnonymously(auth)
  return credential.user
}

export async function subscribeToTripDirectory(onValue, onError) {
  const { collection, db, onSnapshot } = await loadFirebaseServices()

  if (!db || !collection) return () => {}

  const tripsCollection = collection(db, 'trips')

  return onSnapshot(
    tripsCollection,
    (snapshot) =>
      onValue(
        snapshot.docs
          .map((entry) => ({
            id: entry.id,
            ...entry.data(),
          }))
          .filter((entry) => !entry.hidden),
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

  await setDoc(overridesDoc, payload, { merge: true })
}

export async function createTripRecord(tripId, payload) {
  const { db, doc, serverTimestamp, setDoc } = await loadFirebaseServices()

  if (!db || !tripId) return

  const tripDoc = doc(db, 'trips', tripId)
  const overridesDoc = doc(db, 'trips', tripId, 'overrides', 'shared')

  await setDoc(
    tripDoc,
    stripUndefined({
      title: payload.title,
      startDate: payload.startDate,
      endDate: payload.endDate,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )

  await setDoc(
    overridesDoc,
    {
      updatedAt: serverTimestamp(),
      days: stampEntityMap(payload.days, serverTimestamp),
      items: stampEntityMap(payload.items, serverTimestamp),
    },
    { merge: true },
  )
}

export async function upsertTripMeta(tripId, payload) {
  const { db, doc, serverTimestamp, setDoc } = await loadFirebaseServices()

  if (!db || !tripId) return

  const tripDoc = doc(db, 'trips', tripId)
  await setDoc(
    tripDoc,
    stripUndefined({
      ...payload,
      updatedAt: serverTimestamp(),
    }),
    { merge: true },
  )
}
