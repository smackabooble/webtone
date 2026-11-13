import { hzToMidi, type Note } from './segment';
import { snapToScale } from './scale';

/** The three global controls, modelled on Newtone's Center / Variation / Transition knobs. */
export interface Params {
  /** 0..1: how far every note is pulled to the nearest note of the scale. */
  center: number;
  /** 0..1: how much of the natural pitch movement inside a note (vibrato, drift, scoops) is removed. */
  variation: number;
  /** Milliseconds over which pitch moves between notes. */
  transitionMs: number;
  /** Pitch classes of the scale, indexed from C. */
  mask: boolean[];
}

export const MAX_SHIFT = 14;

/** Automatic correction for a note, from the Center control. */
export const autoShift = (n: Note, p: Params) => p.center * (snapToScale(n.pitch, p.mask) - n.pitch);

/** Everything applied to a note's centre pitch: automatic correction plus the user's own edit. */
export const totalShift = (n: Note, p: Params) => autoShift(n, p) + n.shift;

/** True when nothing would change, so the original audio can be used as is. */
export function isNeutral(notes: Note[], p: Params): boolean {
  return p.variation === 0 && notes.every((n) => totalShift(n, p) === 0);
}

/**
 * Semitones to shift each analysis frame by. Inside a note:
 *   target = note pitch + total shift + (1 - variation) * (what was sung - note pitch)
 * so variation = 0 keeps the performance as sung, 1 makes the note dead flat.
 * Then the result is smoothed over the transition time so pitch glides between notes.
 */
export function frameShifts(notes: Note[], f0: Float32Array, hopSec: number, p: Params): Float32Array {
  const T = f0.length;
  const raw = new Float32Array(T);
  for (const n of notes) {
    const total = totalShift(n, p);
    for (let f = n.start; f < Math.min(n.end, T); f++) {
      let s = total;
      if (f0[f] > 0) s -= p.variation * (hzToMidi(f0[f]) - n.pitch);
      raw[f] = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, s));
    }
  }
  const width = Math.max(1, Math.round(p.transitionMs / 1000 / hopSec));
  if (width <= 1) return raw;
  const half = width >> 1;
  const prefix = new Float64Array(T + 1);
  for (let i = 0; i < T; i++) prefix[i + 1] = prefix[i] + raw[i];
  const out = new Float32Array(T);
  for (let i = 0; i < T; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(T, i + half + 1);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}
