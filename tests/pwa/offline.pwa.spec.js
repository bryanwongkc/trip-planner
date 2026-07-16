import { expect, test } from '@playwright/test'

test('precache boots offline and API failures remain JSON', async ({ context, page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('trip-planner-guest-trips-v2')) return
    localStorage.setItem(
      'trip-planner-guest-trips-v2',
      JSON.stringify({
        version: 2,
        trips: {
          offline: {
            summary: {
              id: 'offline',
              title: 'Offline trip',
              role: 'owner',
              hidden: false,
              startDate: '2026-07-16',
              endDate: '2026-07-16',
              city: 'Tokyo',
            },
            overrides: {
              days: { day: { id: 'day', date: '2026-07-16', order: 0 } },
              items: {
                stop: {
                  id: 'stop',
                  dayId: 'day',
                  title: 'Cached stop',
                  category: 'Activity',
                  startTime: '10:00',
                  order: 0,
                },
              },
              bookingOptions: {},
            },
          },
        },
      }),
    )
    localStorage.setItem('trip-planner-active-trip', 'offline')
  })

  await page.goto('/')
  await expect(page.getByText('Cached stop')).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText('Cached stop')).toBeVisible()

  const apiFailure = await page.evaluate(async () => {
    const response = await fetch('/api/aerodatabox?resource=flight-status&flightNumber=CX101')
    return {
      contentType: response.headers.get('content-type'),
      payload: await response.json(),
      status: response.status,
    }
  })
  expect(apiFailure.status).toBe(503)
  expect(apiFailure.contentType).toContain('application/json')
  expect(apiFailure.payload.error).toMatch(/offline/i)
})
