import { describe, expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { psola } from '../src/dsp/psola';
import { hzToMidi, segment } from '../src/dsp/segment';
import { makeDemo } from '../src/audio/demo';
import { SCALES, scaleMask, snapToScale } from '../src/dsp/scale';

const SR = 44100;

function tone(freq: number, sec: number): Float32Array {
  const out = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin((2 * Math.PI * freq * h * i) / SR) / h;
    out[i] = 0.3 * v;
  }
  return out;
}

function medianPitch(x: Float32Array): number {
  const { f0 } = analyze(x, SR);
  const voiced = Array.from(f0)
    .filter((f) => f > 0)
    .sort((a, b) => a - b);
  return hzToMidi(voiced[voiced.length >> 1]);
}

describe('pitch detection', () => {
  it('finds the pitch of a harmonic tone', () => {
    for (const f of [110, 220, 440, 660]) {
      expect(medianPitch(tone(f, 0.5))).toBeCloseTo(hzToMidi(f), 1);
    }
  });

  it('segments the demo melody into its 8 notes', () => {
    const { f0, hopSec } = analyze(makeDemo(SR), SR);
    const notes = segment(f0, hopSec);
    expect(notes.length).toBe(8);
    const expected = [60.3, 62.4, 63.7, 65.2, 67.4, 65.3, 63.6, 60.2];
    notes.forEach((n, i) => expect(Math.abs(n.pitch - expected[i])).toBeLessThan(0.15));
  });
});

describe('scale snapping', () => {
  it('snaps to the nearest semitone in chromatic', () => {
    const m = scaleMask(0, SCALES.Chromatic);
    expect(snapToScale(60.3, m)).toBe(60);
    expect(snapToScale(60.6, m)).toBe(61);
  });

  it('only lands on notes of the chosen key and scale', () => {
    const cMajor = scaleMask(0, SCALES.Major);
    expect(snapToScale(61.2, cMajor)).toBe(62); // C#4 -> D4
    expect(snapToScale(60.8, cMajor)).toBe(60); // closer to C4 than D4
    expect(snapToScale(70.9, cMajor)).toBe(71); // A#4 -> B4
    const aMinor = scaleMask(9, SCALES.Minor);
    expect(snapToScale(68.4, aMinor)).toBe(69); // G#4 -> A4
    const dMajor = scaleMask(2, SCALES.Major);
    expect(snapToScale(60.2, dMajor)).toBe(61); // C4 -> C#4
  });
});

describe('psola', () => {
  it('is transparent when nothing is shifted', () => {
    const x = tone(220, 0.5);
    const { marks } = analyze(x, SR);
    const y = psola(x, marks, () => 1);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(x[i] - y[i]));
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('shifts pitch by the requested interval and keeps the length', () => {
    const x = tone(220, 0.8);
    const { marks } = analyze(x, SR);
    for (const st of [-5, -2, 1, 3, 7]) {
      const y = psola(x, marks, () => Math.pow(2, st / 12));
      expect(y.length).toBe(x.length);
      expect(Math.abs(medianPitch(y) - (hzToMidi(220) + st))).toBeLessThan(0.1);
    }
  });
});

// --- Naturalness -----------------------------------------------------------

/** Glottal-ish pulse train through two resonators, like a sung vowel. */
function vowel(f0: number, sec: number): Float32Array {
  const n = Math.round(sec * SR);
  const out = new Float32Array(n);
  const res = (freq: number, bw: number) => {
    const r = Math.exp((-Math.PI * bw) / SR);
    return { a1: 2 * r * Math.cos((2 * Math.PI * freq) / SR), a2: -r * r, y1: 0, y2: 0 };
  };
  const filters = [res(700, 100), res(1800, 150)];
  const period = SR / f0;
  let next = 0;
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (i >= next) {
      x = 1;
      next += period;
    }
    let y = 0;
    for (const f of filters) {
      const v = x + f.a1 * f.y1 + f.a2 * f.y2;
      f.y2 = f.y1;
      f.y1 = v;
      y += v;
    }
    out[i] = y;
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return out.map((v) => (0.5 * v) / peak);
}

/** Spectral centroid of the 200-2500 Hz band, middle of the signal. */
function centroid(x: Float32Array): number {
  const N = 8192;
  const start = (x.length - N) >> 1;
  let num = 0;
  let den = 0;
  for (let f = 200; f <= 2500; f += 10) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      const ph = (2 * Math.PI * f * i) / SR;
      re += w * x[start + i] * Math.cos(ph);
      im += w * x[start + i] * Math.sin(ph);
    }
    const mag = Math.hypot(re, im);
    num += f * mag * mag;
    den += mag * mag;
  }
  return num / den;
}

function resample(x: Float32Array, ratio: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio;
    const k = Math.floor(p);
    out[i] = k + 1 < x.length ? x[k] * (1 - (p - k)) + x[k + 1] * (p - k) : 0;
  }
  return out;
}

describe('natural sound', () => {
  const x = vowel(120, 1.2);
  const { marks } = analyze(x, SR);
  const base = centroid(x);

  it('keeps the vowel colour (formants) when shifting up', () => {
    const ratio = Math.pow(2, 5 / 12);
    // A plain resample moves the formants with the pitch, so the centroid jumps.
    expect(centroid(resample(x, ratio)) / base).toBeGreaterThan(1.2);
    // PSOLA must not.
    const y = psola(x, marks, () => ratio);
    expect(Math.abs(centroid(y) / base - 1)).toBeLessThan(0.1);
  });

  it('keeps the vowel colour when shifting down', () => {
    const y = psola(x, marks, () => Math.pow(2, -4 / 12));
    expect(Math.abs(centroid(y) / base - 1)).toBeLessThan(0.1);
  });

  it('keeps a steady loudness when shifting down', () => {
    const t = tone(220, 1);
    const m = analyze(t, SR).marks;
    const y = psola(t, m, () => Math.pow(2, -5 / 12));
    const win = Math.round(0.03 * SR);
    let lo = Infinity;
    let hi = 0;
    for (let s = Math.round(0.2 * SR); s + win < Math.round(0.8 * SR); s += win) {
      let e = 0;
      for (let i = 0; i < win; i++) e += y[s + i] * y[s + i];
      const rms = Math.sqrt(e / win);
      lo = Math.min(lo, rms);
      hi = Math.max(hi, rms);
    }
    expect(hi / lo).toBeLessThan(1.15);
  });
});
