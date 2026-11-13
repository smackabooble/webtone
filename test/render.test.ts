import { describe, expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { psola } from '../src/dsp/psola';
import { hzToMidi, segment } from '../src/dsp/segment';
import { frameShifts, isNeutral, type Params } from '../src/dsp/render';
import { SCALES, scaleMask } from '../src/dsp/scale';
import { singPhrase } from './synth';
import { grainHop, renderHeld } from '../src/audio/scrub';

const SR = 44100;
const chromatic = scaleMask(0, SCALES.Chromatic);
const params = (o: Partial<Params>): Params => ({
  center: 0,
  variation: 0,
  transitionMs: 20,
  mask: chromatic,
  ...o,
});

function voiced(f0: Float32Array, from: number, to: number) {
  const m: number[] = [];
  for (let i = from; i < to; i++) if (f0[i] > 0) m.push(hzToMidi(f0[i]));
  return m;
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
const std = (v: number[]) => {
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
};

describe('Center / Variation / Transition', () => {
  // One out-of-tune held note with vibrato.
  const ph = singPhrase([{ midi: 60.4, dur: 1.4, gap: 0.1 }], SR, 3);
  const a = analyze(ph.audio, SR);
  const notes = segment(a.f0, a.hopSec, a.db);

  function process(p: Params) {
    const shifts = frameShifts(notes, a.f0, a.hopSec, p);
    const last = shifts.length - 1;
    const y = psola(ph.audio, a.marks, (s) => Math.pow(2, shifts[Math.min(last, Math.round((s / SR) / a.hopSec))] / 12));
    const b = analyze(y, SR);
    // Look at the steady middle of the note.
    const from = Math.round(0.5 / b.hopSec);
    const to = Math.round(1.3 / b.hopSec);
    return voiced(b.f0, from, to);
  }

  it('finds the one note', () => {
    expect(notes.length).toBe(1);
    expect(notes[0].pitch).toBeCloseTo(60.4, 0);
  });

  it('does nothing at zero', () => {
    expect(isNeutral(notes, params({}))).toBe(true);
  });

  it('Center pulls the note to the nearest semitone', () => {
    const out = process(params({ center: 1 }));
    expect(Math.abs(median(out) - 60)).toBeLessThan(0.12);
    // Half way: half the distance.
    const half = process(params({ center: 0.5 }));
    expect(Math.abs(median(half) - 60.2)).toBeLessThan(0.12);
  });

  it('Variation flattens vibrato without moving the note', () => {
    const before = std(process(params({})));
    const flat = process(params({ variation: 1 }));
    console.log('pitch spread (semitones) before', before.toFixed(3), 'after', std(flat).toFixed(3));
    expect(std(flat)).toBeLessThan(before * 0.5);
    expect(Math.abs(median(flat) - median(process(params({}))))).toBeLessThan(0.12);
  });

  it('both together give a flat, in-tune note', () => {
    const out = process(params({ center: 1, variation: 1 }));
    expect(Math.abs(median(out) - 60)).toBeLessThan(0.12);
    expect(std(out)).toBeLessThan(0.1);
  });

  it('Transition smooths the jump between notes', () => {
    const two = [
      { start: 0, end: 40, pitch: 60, shift: 0 },
      { start: 40, end: 80, pitch: 60, shift: 2 },
    ];
    const f0 = new Float32Array(80).fill(261.6);
    const sharp = frameShifts(two, f0, 0.005, params({ transitionMs: 0 }));
    const smooth = frameShifts(two, f0, 0.005, params({ transitionMs: 100 }));
    const maxStep = (x: Float32Array) => x.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - x[i - 1])) : m), 0);
    expect(maxStep(sharp)).toBeCloseTo(2, 5);
    expect(maxStep(smooth)).toBeLessThan(0.2);
  });
});

describe('holding the playhead', () => {
  // A steady sung vowel; hold the playhead on it for a second.
  const x = singPhrase([{ midi: 57, dur: 2 }], SR, 9);
  const src = analyze(x.audio, SR);
  const pos = 1.0;
  const frame = Math.round(pos / src.hopSec);
  const hz = src.f0[frame];
  const midiIn = hzToMidi(hz);

  function held(period: number) {
    const y = renderHeld(x.audio, SR, pos, period, 1.2);
    const a = analyze(y, SR);
    const from = Math.round(0.4 / a.hopSec);
    const to = Math.round(1.0 / a.hopSec);
    const m = voiced(a.f0, from, to);
    // loudness steadiness
    const win = Math.round(0.03 * SR);
    let lo = Infinity;
    let hi = 0;
    for (let s = Math.round(0.4 * SR); s + win < Math.round(1.0 * SR); s += win) {
      let e = 0;
      for (let i = 0; i < win; i++) e += y[s + i] * y[s + i];
      lo = Math.min(lo, Math.sqrt(e / win));
      hi = Math.max(hi, Math.sqrt(e / win));
    }
    return { pitch: m.length ? median(m) : NaN, share: m.length / (to - from), steady: hi / lo };
  }

  it('sustains the pitch under the playhead', () => {
    const r = held(1 / hz);
    console.log('held: pitch in', midiIn.toFixed(2), 'out', r.pitch.toFixed(2), 'voiced', r.share.toFixed(2), 'level spread', r.steady.toFixed(2));
    expect(r.share).toBeGreaterThan(0.9);
    expect(Math.abs(r.pitch - midiIn)).toBeLessThan(0.15);
    expect(r.steady).toBeLessThan(1.3);
  });

  it('spaces grains a whole number of periods apart', () => {
    for (const f of [110, 180, 261.6, 330, 523]) {
      const T = 1 / f;
      const hop = grainHop(T);
      expect(Math.abs(hop / T - Math.round(hop / T))).toBeLessThan(1e-9);
      expect(Math.abs(hop - 0.025)).toBeLessThan(T / 2 + 1e-9);
    }
    expect(grainHop(0)).toBeCloseTo(0.025, 6);
  });
});
