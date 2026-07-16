import { expect, test } from '@playwright/test'

const guestStore = {
  version: 2,
  trips: {
    'trip-a': {
      summary: {
        id: 'trip-a',
        title: 'Trip A',
        role: 'owner',
        hidden: false,
        startDate: '2026-07-16',
        endDate: '2026-07-16',
        city: 'Tokyo',
      },
      overrides: {
        days: { 'day-a': { id: 'day-a', date: '2026-07-16', order: 0 } },
        items: {
          'item-a': {
            id: 'item-a',
            dayId: 'day-a',
            title: 'Alpha stop',
            category: 'Activity',
            startTime: '10:00',
            order: 0,
          },
        },
        bookingOptions: {},
      },
    },
    'trip-b': {
      summary: {
        id: 'trip-b',
        title: 'Trip B',
        role: 'owner',
        hidden: false,
        startDate: '2026-08-01',
        endDate: '2026-08-01',
        city: 'Osaka',
      },
      overrides: {
        days: { 'day-b': { id: 'day-b', date: '2026-08-01', order: 0 } },
        items: {
          'item-b': {
            id: 'item-b',
            dayId: 'day-b',
            title: 'Beta stop',
            category: 'Activity',
            startTime: '11:00',
            order: 0,
          },
        },
        bookingOptions: {},
      },
    },
  },
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((store) => {
    if (!localStorage.getItem('trip-planner-guest-trips-v2')) {
      localStorage.setItem('trip-planner-guest-trips-v2', JSON.stringify(store))
    }
    if (!localStorage.getItem('trip-planner-active-trip')) {
      localStorage.setItem('trip-planner-active-trip', 'trip-a')
    }
  }, guestStore)
})

test('persists independent guest trips and preserves app-like selection behavior', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Alpha stop')).toBeVisible()

  await page.getByRole('button', { name: 'Open menu' }).click()
  const drawer = page.locator('aside[aria-label="Trip menu"]')
  await expect(drawer).toHaveAttribute('aria-hidden', 'false')
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveAttribute('aria-hidden', 'true')

  await page.getByRole('button', { name: 'Open menu' }).click()
  await drawer.getByRole('button', { name: /Trip A/ }).click()
  await drawer.getByRole('button', { name: /Trip B/ }).click()
  await expect(page.getByText('Beta stop')).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('trip-planner-active-trip'))).toBe('trip-b')

  await page.reload()
  await expect(page.getByText('Beta stop')).toBeVisible()

  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content')
  expect(viewport).not.toContain('user-scalable=no')
  expect(viewport).not.toContain('maximum-scale')

  const guards = await page.evaluate(() => {
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true })
    document.dispatchEvent(wheel)
    const selection = new Event('selectstart', { bubbles: true, cancelable: true })
    document.body.dispatchEvent(selection)
    const input = document.createElement('input')
    document.body.appendChild(input)
    const inputSelection = new Event('selectstart', { bubbles: true, cancelable: true })
    input.dispatchEvent(inputSelection)
    input.remove()
    return {
      zoomPrevented: wheel.defaultPrevented,
      bodySelectionPrevented: selection.defaultPrevented,
      inputSelectionPrevented: inputSelection.defaultPrevented,
    }
  })
  expect(guards).toEqual({
    zoomPrevented: false,
    bodySelectionPrevented: true,
    inputSelectionPrevented: false,
  })
})
