// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { normalizeLookupEmail } from '../api/lookup-user'

describe('collaborator lookup validation', () => {
  it('normalizes valid email and rejects malformed or oversized values', () => {
    expect(normalizeLookupEmail(' Person@Example.COM ')).toBe('person@example.com')
    expect(normalizeLookupEmail('not-an-email')).toBe('')
    expect(normalizeLookupEmail(`${'a'.repeat(250)}@example.com`)).toBe('')
  })
})
