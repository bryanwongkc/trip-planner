export const REORDER_TOUCH_HOLD_MS = 300
export const REORDER_TOUCH_SCROLL_TOLERANCE = 10
export const REORDER_POINTER_DRAG_THRESHOLD = 6

export function pendingReorderGestureAction({
  pointerType,
  originX,
  originY,
  clientX,
  clientY,
}) {
  const movedX = Math.abs(clientX - originX)
  const movedY = Math.abs(clientY - originY)
  const distance = Math.max(movedX, movedY)

  if (pointerType === 'touch') {
    return distance > REORDER_TOUCH_SCROLL_TOLERANCE ? 'cancel' : 'wait'
  }

  return distance >= REORDER_POINTER_DRAG_THRESHOLD ? 'activate' : 'wait'
}
