// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ verify: vi.fn(), write: vi.fn(), db: {} }))
vi.mock('../server/firebaseAdmin.js', () => ({ verifyFirebaseRequest: mocks.verify, getFirebaseAdminServices: () => ({ db: mocks.db }) }))
vi.mock('../server/tripState.js', () => ({ writeTripState: mocks.write }))
import handler from '../api/trip-state'
function response() {
  return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
}
beforeEach(() => { vi.clearAllMocks(); mocks.verify.mockResolvedValue({ uid: 'user' }); mocks.write.mockResolvedValue({ revision: 1 }) })

it('requires sign-in before the privileged write service runs', async () => {
  mocks.verify.mockResolvedValue(null)
  const res = response()
  await handler({ method: 'POST', body: {} }, res)
  expect(res.status).toHaveBeenCalledWith(401)
  expect(mocks.write).not.toHaveBeenCalled()
})
it('passes the verified actor and a bounded body, and rejects malformed JSON', async () => {
  const res = response()
  await handler({ method: 'POST', body: JSON.stringify({ action: 'patch' }) }, res)
  expect(mocks.write).toHaveBeenCalledWith(mocks.db, { uid: 'user' }, { action: 'patch' })
  await handler({ method: 'POST', body: '{broken' }, res)
  expect(res.status).toHaveBeenLastCalledWith(400)
  await handler({ method: 'POST', body: { text: '旅'.repeat(700_000) } }, res)
  expect(res.status).toHaveBeenLastCalledWith(413)
  expect(mocks.write).toHaveBeenCalledTimes(1)
})
it('returns conflicts distinctly and hides unexpected infrastructure errors', async () => {
  const res = response()
  mocks.write.mockRejectedValue(Object.assign(new Error('Changed elsewhere'), { code: 'trip-version-conflict' }))
  await handler({ method: 'POST', body: {} }, res)
  expect(res.status).toHaveBeenLastCalledWith(409)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.write.mockRejectedValue(Object.assign(new Error('Internal credential details'), { code: 14 }))
  await handler({ method: 'POST', body: {} }, res)
  expect(res.status).toHaveBeenLastCalledWith(503)
  expect(JSON.stringify(res.json.mock.lastCall)).not.toContain('credential')
  log.mockRestore()
})
