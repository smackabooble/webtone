/**
 * Scrubbing: while the playhead is held, the audio under it is played as short overlapping
 * grains. If the voice is pitched, the grains are spaced a whole number of its periods apart,
 * so they add up in step and the held note sounds steady at its real pitch, for as long as
 * you hold it. Moving the playhead just moves where the grains are taken from.
 */

export const GRAIN_SEC = 0.1;
const TARGET_HOP_SEC = 0.025;

/** Spacing between grains: about 25 ms, rounded to a whole number of pitch periods. */
export function grainHop(periodSec: number): number {
  if (!(periodSec > 0)) return TARGET_HOP_SEC;
  return Math.max(1, Math.round(TARGET_HOP_SEC / periodSec)) * periodSec;
}

/** Hann window for a grain. Overlapped at spacing h it sums to GRAIN_SEC / (2h). */
export function hannCurve(n = 64): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
}

/** Gain that makes overlapped grains add up to unity. */
export const grainGain = (hop: number) => (2 * hop) / GRAIN_SEC;

/** The same thing done offline, for testing: hold the playhead at `pos` for `durSec`. */
export function renderHeld(
  x: Float32Array,
  sr: number,
  pos: number,
  periodSec: number,
  durSec: number,
): Float32Array {
  const out = new Float32Array(Math.round(durSec * sr));
  const hop = grainHop(periodSec);
  const len = Math.round(GRAIN_SEC * sr);
  const src0 = Math.round((pos - GRAIN_SEC / 2) * sr);
  const gain = grainGain(hop);
  for (let t = 0; t < durSec; t += hop) {
    const start = Math.round(t * sr);
    for (let i = 0; i < len; i++) {
      const o = start + i;
      const s = src0 + i;
      if (o >= out.length || s < 0 || s >= x.length) continue;
      out[o] += gain * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1))) * x[s];
    }
  }
  return out;
}
