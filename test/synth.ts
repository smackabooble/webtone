/** Deterministic synthetic singing, with ground truth, for testing detection. */

export interface SynthNote {
  midi: number;
  dur: number;
  /** Silence after this note, in seconds. 0 = next note follows legato. */
  gap?: number;
  /** Unvoiced burst (like "t" or "s") in the gap. */
  consonant?: boolean;
  /** Loudness dip, in dB, at the start of a legato note (separate syllable, same breath). */
  dip?: number;
}

export interface TruthNote {
  start: number;
  end: number;
  midi: number;
}

export interface Phrase {
  audio: Float32Array;
  truth: TruthNote[];
  /** True fundamental per sample in Hz, 0 where unvoiced or silent. */
  f0: Float32Array;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function singPhrase(notes: SynthNote[], sr = 44100, seed = 1): Phrase {
  const rand = rng(seed);
  const lead = 0.15;
  let total = lead;
  for (const n of notes) total += n.dur + (n.gap ?? 0);
  total += 0.2;
  const N = Math.round(total * sr);
  const audio = new Float32Array(N);
  const f0 = new Float32Array(N);
  const truth: TruthNote[] = [];

  // Vocal tract: three resonators.
  const res = [
    [700, 100],
    [1200, 120],
    [2600, 150],
  ].map(([f, bw]) => {
    const r = Math.exp((-Math.PI * bw) / sr);
    return { a1: 2 * r * Math.cos((2 * Math.PI * f) / sr), a2: -r * r, y1: 0, y2: 0 };
  });

  // Slow random pitch drift, as a smoothed random walk.
  let driftTarget = 0;
  let drift = 0;
  let phase = 0;
  let t0 = lead;
  let prevMidi = notes[0].midi;
  let prevGap = 1;
  let hp = 0;

  const emit = (i: number, x: number) => {
    let y = 0;
    for (const f of res) {
      const v = x + f.a1 * f.y1 + f.a2 * f.y2;
      f.y2 = f.y1;
      f.y1 = v;
      y += v;
    }
    audio[i] += y;
  };

  for (let k = 0; k < notes.length; k++) {
    const n = notes[k];
    const s0 = Math.round(t0 * sr);
    const len = Math.round(n.dur * sr);
    truth.push({ start: t0, end: t0 + n.dur, midi: n.midi });
    const legato = prevGap === 0 && k > 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      if (i % 2000 === 0) driftTarget = (rand() - 0.5) * 0.3;
      drift += (driftTarget - drift) * 0.0004;
      let midi = n.midi;
      if (legato) midi += (prevMidi - n.midi) * Math.exp(-t / 0.03);
      else midi += -1.2 * Math.exp(-t / 0.06);
      const vibDepth = 0.35 * smooth((t - 0.15) / 0.2);
      midi += vibDepth * Math.sin(2 * Math.PI * 5.6 * t) + drift;
      const f = 440 * Math.pow(2, (midi - 69) / 12);

      // Level: attack, release, tremolo, and a dip at repeated-note boundaries.
      let g = Math.min(1, t / 0.025, (n.dur - t) / 0.04);
      g *= Math.pow(10, (1.2 * Math.sin(2 * Math.PI * 5.6 * t + 1)) / 20);
      if (legato && n.dip) g *= Math.pow(10, (-n.dip * Math.exp(-((t / 0.03) ** 2))) / 20);

      phase += f / sr;
      let pulse = 0;
      if (phase >= 1) {
        phase -= 1;
        pulse = 1;
      }
      const breath = (rand() - 0.5) * 0.04;
      emit(s0 + i, g * (pulse + breath));
      f0[s0 + i] = f;
    }
    // Consonant burst in the gap.
    const gap = n.gap ?? 0;
    if (n.consonant && gap > 0.04) {
      const b0 = s0 + len + Math.round(0.01 * sr);
      const bl = Math.round(Math.min(gap - 0.015, 0.05) * sr);
      for (let i = 0; i < bl; i++) {
        const w = rand() - 0.5;
        hp = w - hp * 0.5;
        audio[b0 + i] += 0.12 * hp * Math.sin((Math.PI * i) / bl);
      }
    }
    prevMidi = n.midi;
    prevGap = gap;
    t0 += n.dur + gap;
  }
  let peak = 0;
  for (const v of audio) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < N; i++) audio[i] = (0.6 * audio[i]) / peak;
  return { audio, truth, f0 };
}

export interface Score {
  precision: number;
  recall: number;
  f1: number;
  detected: number;
  truth: number;
  /** Mean absolute pitch error of matched notes, in semitones. */
  pitchErr: number;
}

/** A detected note matches a true one if its onset is within 80 ms and pitch within half a semitone. */
export function scoreNotes(
  truth: TruthNote[],
  det: { start: number; pitch: number }[],
): Score {
  const used = new Set<number>();
  let hit = 0;
  let err = 0;
  for (const t of truth) {
    let best = -1;
    let bestD = Infinity;
    det.forEach((d, i) => {
      if (used.has(i)) return;
      const dt = Math.abs(d.start - t.start);
      if (dt <= 0.08 && Math.abs(d.pitch - t.midi) <= 0.5 && dt < bestD) {
        best = i;
        bestD = dt;
      }
    });
    if (best >= 0) {
      used.add(best);
      hit++;
      err += Math.abs(det[best].pitch - t.midi);
    }
  }
  const precision = det.length ? hit / det.length : 0;
  const recall = truth.length ? hit / truth.length : 0;
  return {
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    detected: det.length,
    truth: truth.length,
    pitchErr: hit ? err / hit : 0,
  };
}

/** A few phrases covering the cases that matter: legato, repeats, consonants, wide leaps, short notes. */
export const PHRASES: Record<string, SynthNote[]> = {
  legato: [
    { midi: 60, dur: 0.5, gap: 0.05, consonant: true },
    { midi: 62, dur: 0.6 },
    { midi: 64, dur: 0.5 },
    { midi: 65, dur: 0.4, gap: 0.1 },
    { midi: 67, dur: 0.8, gap: 0.08, consonant: true },
    { midi: 65, dur: 0.3 },
    { midi: 64, dur: 0.3 },
    { midi: 60, dur: 0.9, gap: 0.2 },
  ],
  repeats: [
    { midi: 64, dur: 0.35 },
    { midi: 64, dur: 0.35, dip: 14 },
    { midi: 64, dur: 0.35, dip: 14 },
    { midi: 67, dur: 0.5, gap: 0.12, consonant: true },
    { midi: 67, dur: 0.4, gap: 0.06 },
    { midi: 69, dur: 0.7, gap: 0.2 },
  ],
  leaps: [
    { midi: 55, dur: 0.45, gap: 0.08 },
    { midi: 67, dur: 0.45, gap: 0.08 },
    { midi: 58, dur: 0.3 },
    { midi: 70, dur: 0.3 },
    { midi: 62, dur: 0.6, gap: 0.1 },
    { midi: 74, dur: 0.5, gap: 0.2 },
  ],
};
