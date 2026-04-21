import { TRIP_ID } from '../data/seedItinerary'

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

export async function ensureAnonymousAuth() {
  const { auth, signInAnonymously } = await loadFirebaseServices()

  if (!auth) {
    return null
  }

  if (auth.currentUser) {
    return auth.currentUser
  }

  const credential = await signInAnonymously(auth)
  return credential.user
}

export async function subscribeToOverrides(onValue, onError) {
  const { db, doc, onSnapshot } = await loadFirebaseServices()

  if (!db) {
    return () => {}
  }

  const overridesDoc = doc(db, 'trips', TRIP_ID, 'overrides', 'shared')

  return onSnapshot(
    overridesDoc,
    (snapshot) => onValue(snapshot.exists() ? snapshot.data() : null),
    onError,
  )
}

export async function upsertItemOverride(itemId, override) {
  const { db, doc, serverTimestamp, setDoc } = await loadFirebaseServices()

  if (!db) {
    return
  }

  const overridesDoc = doc(db, 'trips', TRIP_ID, 'overrides', 'shared')

  await setDoc(
    overridesDoc,
    {
      items: {
        [itemId]: stripUndefined({
          ...override,
          updatedAt: serverTimestamp(),
        }),
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}
