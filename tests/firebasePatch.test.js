import { describe, expect, it } from 'vitest'
import { buildStampedPatch } from '../src/services/firebase'
import { mergeTripEntityMaps } from '../src/utils/tripValidation'

const timestamp = { type: 'server-timestamp' }
const serverTimestamp = () => timestamp

describe('Firestore patch serialization', () => {
  it.each(['days', 'items', 'bookingOptions'])(
    'omits an empty %s patch instead of replacing the stored map',
    (key) => {
      expect(buildStampedPatch({ [key]: {} }, serverTimestamp)).toEqual({
        updatedAt: timestamp,
      })
    },
  )

  it('omits empty item and booking maps when deleting an empty day', () => {
    const patch = {
      days: { first: { order: 0 }, last: { hidden: true } },
      items: {},
      bookingOptions: {},
    }
    expect(buildStampedPatch(patch, serverTimestamp)).toEqual({
      updatedAt: timestamp,
      days: {
        first: { order: 0, updatedAt: timestamp },
        last: { hidden: true, updatedAt: timestamp },
      },
    })
  })

  it('keeps populated patches and explicit false, zero, empty-string, and null fields', () => {
    const patch = {
      items: {
        event: {
          hidden: false,
          order: 0,
          description: '',
          lat: null,
          lng: undefined,
          updatedAt: 'old-timestamp',
        },
      },
    }
    expect(buildStampedPatch(patch, serverTimestamp)).toEqual({
      updatedAt: timestamp,
      items: {
        event: { hidden: false, order: 0, description: '', lat: null, updatedAt: timestamp },
      },
    })
  })

  it('preserves the local merge contract that empty maps are no-ops', () => {
    const current = {
      days: { first: { id: 'first', date: '2030-01-01' } },
      items: { event: { id: 'event', dayId: 'first', title: 'Keep me' } },
      bookingOptions: { booking: { id: 'booking', linkedItemId: 'event' } },
    }
    const patch = { days: {}, items: {}, bookingOptions: {} }
    expect(mergeTripEntityMaps(current, patch)).toEqual(current)
    expect(buildStampedPatch(patch, serverTimestamp)).toEqual({ updatedAt: timestamp })
  })
})
