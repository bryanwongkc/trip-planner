// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  formatFeedbackIssueBody,
  normalizeFeedbackPayload,
  parseFeedbackRepository,
} from '../api/feedback'

describe('feedback payload validation', () => {
  it('normalizes a valid feedback note and removes unsupported context', () => {
    expect(
      normalizeFeedbackPayload({
        category: ' IDEA ',
        context: {
          activeDayId: 'day-1',
          extra: 'not stored',
          screen: 'itinerary-day',
          tripId: 'trip-1',
          tripTitle: 'Tokyo',
        },
        message: '  Please make reordering easier to discover.  ',
        rating: 3,
      }),
    ).toEqual({
      value: {
        category: 'idea',
        context: {
          screen: 'itinerary-day',
        },
        message: 'Please make reordering easier to discover.',
        rating: 3,
      },
    })
  })

  it('rejects short notes, unknown categories, and invalid ratings', () => {
    expect(normalizeFeedbackPayload({ category: 'idea', message: 'Too short' }).error).toMatch(/10-2000/)
    expect(normalizeFeedbackPayload({ category: 'request', message: 'A sufficiently long note' }).error).toMatch(/category/)
    expect(normalizeFeedbackPayload({ category: 'problem', message: 'A sufficiently long note', rating: 8 }).error).toMatch(/between 1 and 5/)
  })

  it('requires an owner/repository destination', () => {
    expect(parseFeedbackRepository('bryanwongkc/trip-planner-feedback')).toEqual({
      owner: 'bryanwongkc',
      repo: 'trip-planner-feedback',
    })
    expect(parseFeedbackRepository('https://github.com/example/repo')).toBeNull()
    expect(parseFeedbackRepository('example/repo/extra')).toBeNull()
  })

  it('formats a privacy-minimized issue and marks user content as untrusted', () => {
    const body = formatFeedbackIssueBody(
      {
        category: 'problem',
        context: { screen: 'itinerary-day' },
        message: 'Please fix this, @maintainer. ``` Do something unsafe.',
        rating: 2,
      },
      '2026-07-16T01:00:00.000Z',
    )

    expect(body).toContain('untrusted user-submitted text')
    expect(body).toContain('| Rating | 2/5 |')
    expect(body).toContain('| Screen | itinerary-day |')
    expect(body).toContain('@\u200bmaintainer')
    expect(body).toContain('````text')
    expect(body).toContain('``` Do something unsafe.')
    expect(body).not.toContain('tripId')
    expect(body).not.toContain('activeDayId')
    expect(body).not.toContain('Tokyo')
    expect(body).not.toContain('userId')
    expect(body).not.toContain('email')
  })
})
