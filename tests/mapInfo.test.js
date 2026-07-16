// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { createMapInfoContent } from '../src/utils/mapInfo'

describe('map info content', () => {
  it('treats itinerary strings as text instead of executable markup', () => {
    const content = createMapInfoContent(
      { title: '<img src=x onerror=alert(1)>', locationName: '<script>alert(1)</script>' },
      '10:00 - 11:00',
    )

    expect(content.querySelector('img')).toBeNull()
    expect(content.querySelector('script')).toBeNull()
    expect(content.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(content.textContent).toContain('<script>alert(1)</script>')
  })
})
