import { decimate, detectPitch } from './yin';
import { findMarks } from './psola';

export interface Analysis {
  f0: Float32Array;
  hopSec: number;
  marks: Int32Array;
}

/** Pitch-track a mono signal and place its pitch marks. */
export function analyze(mono: Float32Array, sr: number): Analysis {
  const factor = Math.max(1, Math.round(sr / 16000));
  const { f0, hopSec } = detectPitch(decimate(mono, factor), sr / factor);
  const marks = findMarks(mono, sr, f0, hopSec);
  return { f0, hopSec, marks };
}
