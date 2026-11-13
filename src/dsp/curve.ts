/**
 * Hand edits to the pitch line. `curve` holds a pitch offset in semitones for every analysis
 * frame, added on top of everything else. Dragging bends the line like a soft brush: the
 * frame under the pointer moves the full amount and the offset falls away smoothly to nothing
 * at the edges of the brush.
 */

export const MAX_CURVE = 12;

/**
 * Set `curve` to `base` plus a bell-shaped bump of `semitones` centred on a frame.
 * Only voiced frames are touched, since unvoiced sound has no pitch to move.
 */
export function bendCurve(
  curve: Float32Array,
  base: Float32Array,
  f0: Float32Array,
  hopSec: number,
  center: number,
  radiusSec: number,
  semitones: number,
): void {
  curve.set(base);
  const R = Math.max(1, Math.round(radiusSec / hopSec));
  for (let f = Math.max(0, center - R); f <= Math.min(curve.length - 1, center + R); f++) {
    if (!(f0[f] > 0)) continue;
    const w = 0.5 * (1 + Math.cos((Math.PI * (f - center)) / R));
    curve[f] = Math.max(-MAX_CURVE, Math.min(MAX_CURVE, base[f] + semitones * w));
  }
}

/** Remove hand edits within the brush around a frame. Returns true if anything changed. */
export function clearCurve(curve: Float32Array, hopSec: number, center: number, radiusSec: number): boolean {
  const R = Math.max(1, Math.round(radiusSec / hopSec));
  let changed = false;
  for (let f = Math.max(0, center - R); f <= Math.min(curve.length - 1, center + R); f++) {
    if (curve[f] !== 0) {
      curve[f] = 0;
      changed = true;
    }
  }
  return changed;
}
