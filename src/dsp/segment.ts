export interface Note {
  /** First frame (inclusive). */
  start: number;
  /** Last frame (exclusive). */
  end: number;
  /** Detected centre pitch as a fractional MIDI note. */
  pitch: number;
  /** User edit in semitones. */
  shift: number;
}

export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

const SPLIT_SEMITONES = 0.8;
const SPLIT_FRAMES = 4;
const MIN_NOTE_SEC = 0.05;

/** Split a pitch track into notes at silences and at sustained pitch jumps. */
export function segment(f0: Float32Array, hopSec: number): Note[] {
  const notes: Note[] = [];
  const n = f0.length;
  const midi = new Float32Array(n);
  for (let i = 0; i < n; i++) midi[i] = f0[i] > 0 ? hzToMidi(f0[i]) : NaN;

  const close = (s: number, e: number) => {
    if ((e - s) * hopSec < MIN_NOTE_SEC) return;
    const vals = Array.from(midi.subarray(s, e)).sort((a, b) => a - b);
    notes.push({ start: s, end: e, pitch: vals[vals.length >> 1], shift: 0 });
  };

  let s = -1;
  let sum = 0;
  let cnt = 0;
  let dev = 0;
  for (let i = 0; i <= n; i++) {
    const m = i < n ? midi[i] : NaN;
    const voiced = !Number.isNaN(m);
    if (s < 0) {
      if (voiced) {
        s = i;
        sum = m;
        cnt = 1;
        dev = 0;
      }
    } else if (!voiced) {
      close(s, i);
      s = -1;
    } else if (Math.abs(m - sum / cnt) > SPLIT_SEMITONES) {
      dev++;
      if (dev >= SPLIT_FRAMES) {
        const split = i - SPLIT_FRAMES + 1;
        close(s, split);
        s = split;
        sum = 0;
        cnt = 0;
        for (let j = split; j <= i; j++) {
          sum += midi[j];
          cnt++;
        }
        dev = 0;
      }
    } else {
      dev = 0;
      sum += m;
      cnt++;
    }
  }
  return notes;
}
