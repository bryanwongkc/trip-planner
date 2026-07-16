import { getFirebaseAdminServices, verifyFirebaseRequest } from '../server/firebaseAdmin.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const requestWindows = new Map()
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 30

export function normalizeLookupEmail(value) {
  const email = String(value || '').trim().toLowerCase()
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : ''
}

function isRateLimited(uid, now = Date.now()) {
  const window = requestWindows.get(uid)
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    requestWindows.set(uid, { count: 1, startedAt: now })
    return false
  }
  window.count += 1
  return window.count > RATE_LIMIT
}

export default async function handler(request, response) {
  response.setHeader?.('Cache-Control', 'private, no-store')
  if (request.method !== 'GET') {
    response.status(405).json({ error: 'Method not allowed' })
    return
  }

  const email = normalizeLookupEmail(request.query?.email)
  const tripId = String(request.query?.tripId || '').trim()
  if (!email || !tripId || tripId.length > 128 || tripId.includes('/')) {
    response.status(400).json({ error: 'Invalid lookup request' })
    return
  }

  try {
    const token = await verifyFirebaseRequest(request)
    if (!token?.uid) {
      response.status(401).json({ error: 'Authentication required' })
      return
    }
    if (isRateLimited(token.uid)) {
      response.status(429).json({ error: 'Too many lookup requests' })
      return
    }

    const { auth, db } = getFirebaseAdminServices()
    const member = await db.doc(`trips/${tripId}/members/${token.uid}`).get()
    if (!member.exists || !['owner', 'admin'].includes(member.data()?.role)) {
      response.status(403).json({ error: 'Trip manager access required' })
      return
    }

    const user = await auth.getUserByEmail(email)
    response.status(200).json({
      uid: user.uid,
      displayName: user.displayName || '',
      email: user.email || email,
      photoURL: user.photoURL || '',
    })
  } catch (error) {
    if (error?.code === 'auth/user-not-found') {
      response.status(404).json({ error: 'User not found' })
      return
    }
    console.error('User lookup failed', error)
    response.status(503).json({ error: 'User lookup is temporarily unavailable' })
  }
}
