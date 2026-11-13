import { decimate, detectPitch } from './yin';
import { findMarks } from './psola';

export interface Analysis {
  f0: Float32Array;
  hopSec: number;
  marks: Int32Array;
  /** Loudness per frame, 0..1, smoothed. */
  env: Float32Array;
}

/** Pitch-track a mono signal and place its pitch marks. */
export function analyze(mono: Float32Array, sr: number): Analysis {
  const factor = Math.max(1, Math.round(sr / 16000));
  const { f0, hopSec, rms } = detectPitch(decimate(mono, factor), sr / factor);
  const marks = findMarks(mono, sr, f0, hopSec);
  return { f0, hopSec, marks, env: toEnvelope(rms) };
}

/** Normalise to the loudest frame, take a square root so quiet parts stay visible, and smooth. */
function toEnvelope(rms: Float32Array): Float32Array {
  let max = 1e-9;
  for (const v of rms) if (v > max) max = v;
  const out = new Float32Array(rms.length);
  const R = 3;
  for (let i = 0; i < rms.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = -R; k <= R; k++) {
      const j = i + k;
      if (j >= 0 && j < rms.length) {
        s += Math.sqrt(rms[j] / max);
        c++;
      }
    }
    out[i] = s / c;
  }
  return out;
}
