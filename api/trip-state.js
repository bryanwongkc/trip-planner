import { getFirebaseAdminServices, verifyFirebaseRequest } from '../server/firebaseAdmin.js'
import { writeTripState } from '../server/tripState.js'

export default async function handler(request, response) {
  response.setHeader?.('Cache-Control', 'private, no-store')
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })
  try {
    const actor = await verifyFirebaseRequest(request)
    if (!actor?.uid) return response.status(401).json({ error: 'Sign in to save your trip.' })
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body
    if (new TextEncoder().encode(JSON.stringify(body || {})).byteLength > 2_000_000) return response.status(413).json({ error: 'These changes are too large to save.' })
    const { db } = getFirebaseAdminServices()
    return response.status(200).json(await writeTripState(db, actor, body))
  } catch (error) {
    if (error?.code === 'trip-version-conflict') return response.status(409).json({ error: error.message, code: error.code })
    if (typeof error?.code === 'string' && error.code.startsWith('auth/')) return response.status(401).json({ error: 'Please sign in again to synchronize your trip.' })
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid trip changes.' })
    if ([400, 403, 404, 409, 413].includes(error?.status)) return response.status(error.status).json({ error: error.message })
    console.error('Trip synchronization failed', error?.code || 'unknown')
    return response.status(503).json({ error: 'Synchronization is temporarily unavailable. Your changes remain on this device.' })
  }
}
