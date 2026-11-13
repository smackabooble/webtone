import { describe, expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { hzToMidi } from '../src/dsp/segment';
import { passesFor, shiftPitch } from '../src/dsp/shift';
import { frameShifts, type Params } from '../src/dsp/render';
import { SCALES, scaleMask } from '../src/dsp/scale';
import { singPhrase } from './synth';

const SR = 44100;
const params: Params = { center: 0, variation: 0, transitionMs: 0, mask: scaleMask(0, SCALES.Chromatic) };

describe('pitch shifts of any size', () => {
  /** A steady sung vowel on a given note, analysed. */
  function voice(midi: number) {
    const ph = singPhrase([{ midi, dur: 2.2, gap: 0.2 }], SR, 5);
    return { audio: ph.audio, a: analyze(ph.audio, SR) };
  }
  function shiftedBy(v: ReturnType<typeof voice>, semitones: number, speed = 1) {
    const ratio = new Float32Array(v.a.f0.length).fill(Math.pow(2, semitones / 12));
    return shiftPitch(v.audio, SR, v.a.marks, v.a.f0, v.a.hopSec, ratio, speed);
  }
  function measure(y: Float32Array, from: number, to: number) {
    const b = analyze(y, SR);
    const v: number[] = [];
    let total = 0;
    for (let i = Math.round(from / b.hopSec); i < Math.round(to / b.hopSec); i++) {
      total++;
      if (b.f0[i] > 0) v.push(hzToMidi(b.f0[i]));
    }
    v.sort((p, q) => p - q);
    return { pitch: v[v.length >> 1], voiced: v.length / total };
  }

  it('uses one pass for modest moves and more beyond', () => {
    const r = (st: number) => new Float32Array(10).fill(Math.pow(2, st / 12));
    expect(passesFor(r(0))).toBe(1);
    expect(passesFor(r(12))).toBe(1);
    expect(passesFor(r(-7))).toBe(1);
    expect(passesFor(r(-12))).toBe(2); // an octave down is taken in two smaller steps
    expect(passesFor(r(13))).toBe(2);
    expect(passesFor(r(36))).toBe(3);
    expect(passesFor(r(-24))).toBeGreaterThan(2); // far down is taken in many small steps
    expect(passesFor(r(500))).toBeLessThanOrEqual(16);
  });

  // Each case starts from a note chosen so that the result is still within what the pitch tracker can measure.
  const cases = [
    { st: -36, from: 76 },
    { st: -24, from: 68 },
    { st: -15, from: 60 },
    { st: -12, from: 60 },
    { st: -7, from: 60 },
    { st: 15, from: 57 },
    { st: 24, from: 48 },
    { st: 36, from: 45 },
  ];
  for (const { st, from } of cases) {
    it(`${st > 0 ? '+' : ''}${st} semitones lands on the right pitch`, () => {
      const v = voice(from);
      const before = measure(v.audio, 0.6, 1.6).pitch;
      const y = shiftedBy(v, st);
      expect(y.length).toBe(v.audio.length);
      const r = measure(y, 0.6, 1.6);
      console.log(`${st} st from note ${from}: pitch ${r.pitch.toFixed(2)} (wanted ${(before + st).toFixed(2)}), voiced ${r.voiced.toFixed(2)}`);
      expect(Math.abs(r.pitch - (before + st))).toBeLessThan(0.5);
      // Beyond an octave down the sound gets rougher; it should still read as a pitched voice.
      expect(r.voiced).toBeGreaterThan(st < -12 ? 0.4 : 0.8);
      let peak = 0;
      for (const x of y) {
        expect(Number.isFinite(x)).toBe(true);
        peak = Math.max(peak, Math.abs(x));
      }
      expect(peak).toBeGreaterThan(0.01);
      expect(peak).toBeLessThan(4);
    });
  }

  it('combines with time stretching', () => {
    const v = voice(69);
    const before = measure(v.audio, 0.6, 1.6).pitch;
    const y = shiftedBy(v, -19, 1.5);
    expect(Math.abs(y.length / (v.audio.length / 1.5) - 1)).toBeLessThan(0.001);
    expect(Math.abs(measure(y, 0.6 / 1.5, 1.6 / 1.5).pitch - (before - 19))).toBeLessThan(0.5);
  });

  it('is not clamped when frame shifts are worked out', () => {
    const notes = [{ start: 0, end: 20, pitch: 60, shift: 31.5 }];
    const s = frameShifts(notes, new Float32Array(20).fill(261.6), 0.005, params);
    expect(s[10]).toBeCloseTo(31.5, 5);
    const down = frameShifts([{ ...notes[0], shift: -40 }], new Float32Array(20).fill(261.6), 0.005, params);
    expect(down[10]).toBeCloseTo(-40, 5);
  });
});
