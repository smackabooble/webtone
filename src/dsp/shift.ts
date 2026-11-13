import { findMarks, psola } from './psola';

/**
 * Pitch shifting with no limit on the interval. One PSOLA pass is only good for about an octave
 * either way (further than that the grains no longer overlap), so a bigger move is done as several
 * passes, each applying an equal share of it, with fresh pitch marks found on the audio in between.
 */

/** A safety stop, far beyond hearing. */
export const MAX_PASSES = 16;

/**
 * How far one pass may move pitch, in octaves. Going up, an octave is fine. Going down, one pass
 * is fine for up to about seven semitones, but beyond that the grains end up spread so far apart
 * that the result sounds an octave too high, so further down is taken in several smaller steps.
 */
export const MAX_UP_OCTAVES = 1;
export const SINGLE_DOWN_OCTAVES = 0.6;
export const STEP_DOWN_OCTAVES = 0.55;

/** How many passes a set of per-frame pitch ratios needs. */
export function passesFor(ratio: Float32Array): number {
  let up = 0;
  let down = 0;
  for (const r of ratio) {
    const octaves = Math.log2(r > 0 ? r : 1);
    if (octaves > up) up = octaves;
    if (-octaves > down) down = -octaves;
  }
  const upPasses = Math.ceil(up / MAX_UP_OCTAVES - 1e-9);
  const downPasses = down <= SINGLE_DOWN_OCTAVES + 1e-9 ? 1 : Math.ceil(down / STEP_DOWN_OCTAVES - 1e-9);
  return Math.min(MAX_PASSES, Math.max(1, upPasses, downPasses));
}

/**
 * Shift the pitch of `x` by `ratio` (one value per analysis frame) and play it at `speed`.
 * `marks` and `f0` describe `x`: the pitch marks, and the pitch in Hz per frame (0 = unvoiced).
 */
export function shiftPitch(
  x: Float32Array,
  sr: number,
  marks: Int32Array,
  f0: Float32Array,
  hopSec: number,
  ratio: Float32Array,
  speed: number,
): Float32Array<ArrayBuffer> {
  const passes = passesFor(ratio);
  const framesPerSample = 1 / (sr * hopSec);
  const last = ratio.length - 1;
  // Each pass applies the same share of the whole move.
  const step = ratio.map((r) => Math.pow(r > 0 ? r : 1, 1 / passes));

  let audio = x;
  let audioMarks = marks;
  let audioF0 = f0;
  for (let pass = 0; pass < passes; pass++) {
    const final = pass === passes - 1;
    // Time stretching is left to the last pass, so earlier passes stay lined up with the analysis frames.
    const y = psola(audio, audioMarks, (s) => step[Math.min(last, Math.round(s * framesPerSample))], final ? speed : 1);
    if (final) return y;
    // The pitch of what was just made is known, so the next pass can find its marks without re-analysing.
    audioF0 = audioF0.map((hz, i) => (hz > 0 ? hz * step[i] : 0));
    audioMarks = findMarks(y, sr, audioF0, hopSec);
    audio = y;
  }
  return psola(x, marks, () => 1, speed);
}
