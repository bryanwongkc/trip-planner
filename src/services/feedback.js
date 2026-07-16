import { getFirebaseIdToken } from './firebase'

function feedbackError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export async function submitAppFeedback(feedback) {
  const token = await getFirebaseIdToken()
  if (!token) throw feedbackError('Sign in to send feedback.', 'feedback/auth-required')

  let response
  try {
    response = await fetch('/api/feedback', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(feedback),
    })
  } catch {
    throw feedbackError('You appear to be offline. Try again when you are connected.', 'feedback/offline')
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const code = response.status === 429 ? 'feedback/rate-limited' : 'feedback/failed'
    throw feedbackError(payload?.error || 'Feedback could not be sent right now.', code)
  }

  return payload
}
