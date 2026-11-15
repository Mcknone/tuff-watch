// =============================================================================
// Gesture classification (pure, unit-tested). One decision per pointer gesture, so a
// single interaction can never produce two AOI points, and a drag is never a click.
// =============================================================================

// Maximum movement (px) for a press to count as a click: mice are precise, fingers are not.
export const CLICK_TOLERANCE = { mouse: 4, pen: 8, touch: 10 };
export const CLICK_MAX_MS = 800;          // longer presses are holds, not clicks

/**
 * down: { x, y, t, type, maxMove }  (maxMove = largest distance moved during the press)
 * up:   { t, multi }                 (multi = more than one pointer was down during the gesture)
 * → 'click' | 'drag' | 'hold' | 'multi'
 */
export function classifyGesture(down, up) {
  if (up.multi) return 'multi';
  const tol = CLICK_TOLERANCE[down.type] ?? CLICK_TOLERANCE.mouse;
  if ((down.maxMove || 0) > tol) return 'drag';
  if (up.t - down.t > CLICK_MAX_MS) return 'hold';
  return 'click';
}
