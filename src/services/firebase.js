import { getApp, getApps, initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously } from 'firebase/auth'
import { doc, getFirestore, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
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

let appInstance
let authInstance
let firestoreInstance

function getFirebaseApp() {
  if (!firebaseEnabled) {
    return null
  }

  if (!appInstance) {
    appInstance = getApps().length ? getApp() : initializeApp(firebaseConfig)
  }

  return appInstance
}

export function getFirebaseServices() {
  const app = getFirebaseApp()

  if (!app) {
    return { auth: null, db: null }
  }

  if (!authInstance) {
    authInstance = getAuth(app)
  }

  if (!firestoreInstance) {
    firestoreInstance = getFirestore(app)
  }

  return { auth: authInstance, db: firestoreInstance }
}

export async function ensureAnonymousAuth() {
  const { auth } = getFirebaseServices()

  if (!auth) {
    return null
  }

  if (auth.currentUser) {
    return auth.currentUser
  }

  const credential = await signInAnonymously(auth)
  return credential.user
}

function getOverridesDoc() {
  const { db } = getFirebaseServices()

  if (!db) {
    return null
  }

  return doc(db, 'trips', TRIP_ID, 'overrides', 'shared')
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined),
  )
}

export function subscribeToOverrides(onValue, onError) {
  const overridesDoc = getOverridesDoc()

  if (!overridesDoc) {
    return () => {}
  }

  return onSnapshot(
    overridesDoc,
    (snapshot) => onValue(snapshot.exists() ? snapshot.data() : null),
    onError,
  )
}

export async function upsertItemOverride(itemId, override) {
  const overridesDoc = getOverridesDoc()

  if (!overridesDoc) {
    return
  }

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
