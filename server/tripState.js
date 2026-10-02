import { createHash } from 'node:crypto'
import { FieldPath, Timestamp } from 'firebase-admin/firestore'
import { assertTripPatchIsCurrent, validateTripPatch } from '../src/utils/tripValidation.js'
import { ENTITY_KINDS, isRecord, sanitizeTripSnapshot, tripDateRange, validEntityId } from '../src/utils/tripSchema.js'

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function validate(current, patch) {
  try { return validateTripPatch(current, patch) }
  catch (error) { throw requestError(error.message) }
}

function indexPayload(tripId, role, meta, updatedAt) {
  return { tripId, role, title: meta.title, city: meta.city || '', startDate: meta.startDate || '', endDate: meta.endDate || '', hidden: Boolean(meta.hidden), isDemo: Boolean(meta.isDemo), ownerId: meta.ownerId, createdBy: meta.createdBy, updatedAt }
}

export async function writeTripState(db, actor, request) {
  const { action, tripId, operationId } = request || {}
  if (!['create', 'patch', 'metadata'].includes(action) || !validEntityId(tripId) || !validEntityId(operationId)) throw requestError('Invalid trip write request.')
  const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
  const tripRef = db.doc(`trips/${tripId}`)
  const stateRef = tripRef.collection('overrides').doc('shared')
  const memberRef = tripRef.collection('members').doc(actor.uid)
  const receiptRef = tripRef.collection('writeReceipts').doc(`${actor.uid}-${operationId}`)

  return db.runTransaction(async transaction => {
    const [receipt, trip, member, state] = await Promise.all([transaction.get(receiptRef), transaction.get(tripRef), transaction.get(memberRef), transaction.get(stateRef)])
    // Authorization is checked again even for a retry of an acknowledged write.
    if (action !== 'create' && (!trip.exists || !member.exists || !['owner', 'admin', 'editor'].includes(member.data().role))) throw requestError('You no longer have permission to edit this trip.', 403)
    if (receipt.exists) {
      if (receipt.data().digest !== digest) throw requestError('This write ID has already been used.', 409)
      return { revision: receipt.data().revision }
    }
    if (action === 'create' && trip.exists) throw requestError('This trip already exists.', 409)
    const now = Timestamp.now()
    const revision = (Number(state.data()?.revision) || 0) + 1
    let next, meta, members
    if (action === 'create') {
      const source = request.payload
      if (!isRecord(source) || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 500 || typeof source.city !== 'string' || source.city.length > 500) throw requestError('Invalid trip details.')
      next = validate({}, Object.fromEntries(ENTITY_KINDS.map(kind => [kind, source[kind] ?? {}])))
      meta = { title: source.title.trim(), city: source.city, ...tripDateRange(next.days), ownerId: actor.uid, createdBy: actor.uid, hidden: false, isDemo: Boolean(source.isDemo), createdAt: now, updatedAt: now }
    } else {
      if (!state.exists) throw requestError('The saved itinerary was not found.', 404)
      const sanitized = sanitizeTripSnapshot(state.data())
      if (sanitized.invalidCount) throw requestError('This itinerary contains invalid records and needs repair before editing.')
      const patch = action === 'metadata' ? {} : request.patch
      const expected = action === 'metadata' ? {} : request.expectedCurrent
      if (!isRecord(patch) || !isRecord(expected)) throw requestError('A saved version is required for every edit.')
      for (const kind of ENTITY_KINDS) {
        if (Object.keys(patch[kind] || {}).some(id => !Object.hasOwn(expected[kind] || {}, id))) throw requestError('A saved version is required for every edit.')
      }
      assertTripPatchIsCurrent(sanitized.data, patch, expected)
      next = validate(sanitized.data, patch)
      meta = { ...trip.data(), ...tripDateRange(next.days), updatedAt: now }
      if (action === 'metadata') {
        const changes = request.payload
        if (!isRecord(changes) || Object.keys(changes).some(key => !['title', 'hidden'].includes(key))) throw requestError('Invalid trip details.')
        if ('title' in changes && (typeof changes.title !== 'string' || !changes.title.trim() || changes.title.length > 500)) throw requestError('Invalid trip title.')
        if ('hidden' in changes && (typeof changes.hidden !== 'boolean' || member.data().role !== 'owner')) throw requestError('Only the owner can hide or restore this trip.', 403)
        meta = { ...meta, ...changes }
      }
      if (action === 'metadata' || meta.startDate !== trip.data().startDate || meta.endDate !== trip.data().endDate) {
        members = await transaction.get(tripRef.collection('members'))
      }
    }
    if (action === 'create') {
      for (const kind of ENTITY_KINDS) for (const entity of Object.values(next[kind])) entity.updatedAt = now
      transaction.create(tripRef, meta)
      transaction.create(memberRef, { uid: actor.uid, email: actor.email || '', displayName: actor.name || '', photoURL: actor.picture || '', role: 'owner', invitedBy: actor.uid, joinedAt: now, updatedAt: now })
      transaction.set(db.doc(`users/${actor.uid}/tripMemberships/${tripId}`), indexPayload(tripId, 'owner', meta, now))
      transaction.set(stateRef, { ...next, updatedAt: now, revision })
    } else {
      const updates = [new FieldPath('updatedAt'), now, new FieldPath('revision'), revision]
      for (const kind of ENTITY_KINDS) for (const id of Object.keys((action === 'patch' ? request.patch[kind] : {}) || {})) {
        updates.push(new FieldPath(kind, id), { ...next[kind][id], updatedAt: now })
      }
      transaction.update(stateRef, ...updates)
      if (members) {
        transaction.update(tripRef, { title: meta.title, hidden: meta.hidden, startDate: meta.startDate, endDate: meta.endDate, updatedAt: now })
        for (const entry of members.docs) transaction.set(db.doc(`users/${entry.id}/tripMemberships/${tripId}`), indexPayload(tripId, entry.data().role, meta, now), { merge: true })
      }
    }
    transaction.create(receiptRef, { digest, revision, createdAt: now })
    return { revision }
  })
}
