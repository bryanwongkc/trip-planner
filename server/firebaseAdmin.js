/* global process */

import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }
  }

  return null
}

export function getFirebaseAdminServices() {
  if (!getApps().length) {
    const serviceAccount = parseServiceAccount()
    initializeApp({
      credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
      projectId: serviceAccount?.projectId || process.env.FIREBASE_PROJECT_ID,
    })
  }

  return { auth: getAuth(), db: getFirestore() }
}

export async function verifyFirebaseRequest(request) {
  const authorization = String(request.headers?.authorization || '')
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  if (!match) return null

  const { auth } = getFirebaseAdminServices()
  return auth.verifyIdToken(match[1], true)
}
