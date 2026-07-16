import { describe, expect, it } from 'vitest'
import {
  pendingReorderGestureAction,
  REORDER_TOUCH_HOLD_MS,
} from '../src/utils/dragGesture'

describe('reorder drag activation', () => {
  it('requires an intentional hold before touch dragging can activate', () => {
    expect(REORDER_TOUCH_HOLD_MS).toBeGreaterThanOrEqual(250)
  })

  it('cancels a pending touch drag when the finger begins scrolling', () => {
    expect(pendingReorderGestureAction({
      pointerType: 'touch',
      originX: 20,
      originY: 100,
      clientX: 21,
      clientY: 112,
    })).toBe('cancel')
  })

  it('does not activate from normal touch jitter', () => {
    expect(pendingReorderGestureAction({
      pointerType: 'touch',
      originX: 20,
      originY: 100,
      clientX: 23,
      clientY: 106,
    })).toBe('wait')
  })

  it('keeps mouse dragging responsive after a deliberate movement', () => {
    expect(pendingReorderGestureAction({
      pointerType: 'mouse',
      originX: 20,
      originY: 100,
      clientX: 26,
      clientY: 100,
    })).toBe('activate')
  })
})
