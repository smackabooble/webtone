import { describe, expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { psola } from '../src/dsp/psola';
import { bendCurve, clearCurve } from '../src/dsp/curve';
import { frameShifts, isNeutral, type Params } from '../src/dsp/render';
import { hzToMidi, segment } from '../src/dsp/segment';
import { SCALES, scaleMask } from '../src/dsp/scale';
import { singPhrase } from './synth';

const SR = 44100;
const params: Params = { center: 0, variation: 0, transitionMs: 20, mask: scaleMask(0, SCALES.Chromatic) };

describe('bending the pitch line', () => {
  const hop = 0.005;
  const f0 = new Float32Array(200).fill(220);
  for (let i = 90; i < 110; i++) f0[i] = 0; // an unvoiced stretch in the middle

  it('makes a smooth bump that is exact at the centre and gone at the edges', () => {
    const base = new Float32Array(200);
    const curve = new Float32Array(200);
    bendCurve(curve, base, f0, hop, 50, 0.1, 2); // radius 20 frames
    expect(curve[50]).toBeCloseTo(2, 5);
    expect(curve[30]).toBeCloseTo(0, 5);
    expect(curve[70]).toBeCloseTo(0, 5);
    expect(curve[29]).toBe(0);
    expect(curve[71]).toBe(0);
    expect(curve[40]).toBeCloseTo(curve[60], 5);
    expect(curve[40]).toBeGreaterThan(0.5);
    expect(curve[40]).toBeLessThan(2);
  });

  it('adds to earlier edits instead of replacing them', () => {
    const base = new Float32Array(200).fill(0.5);
    const curve = new Float32Array(200);
    bendCurve(curve, base, f0, hop, 50, 0.1, -1);
    expect(curve[50]).toBeCloseTo(-0.5, 5);
    expect(curve[0]).toBeCloseTo(0.5, 5);
  });

  it('leaves unvoiced frames alone', () => {
    const curve = new Float32Array(200);
    bendCurve(curve, new Float32Array(200), f0, hop, 100, 0.2, 3);
    for (let i = 90; i < 110; i++) expect(curve[i]).toBe(0);
    expect(curve[85]).toBeGreaterThan(0);
  });

  it('is capped so it cannot be dragged to extremes', () => {
    const curve = new Float32Array(200);
    bendCurve(curve, new Float32Array(200), f0, hop, 50, 0.1, 40);
    expect(curve[50]).toBeLessThanOrEqual(12);
  });

  it('can be straightened again', () => {
    const curve = new Float32Array(200);
    bendCurve(curve, new Float32Array(200), f0, hop, 50, 0.1, 2);
    expect(clearCurve(curve, hop, 50, 0.1)).toBe(true);
    expect(curve.every((v) => v === 0)).toBe(true);
    expect(clearCurve(curve, hop, 50, 0.1)).toBe(false);
  });

  it('feeds into the shifts, on voiced frames only, and counts as a change', () => {
    const notes = [{ start: 0, end: 200, pitch: 57, shift: 0 }];
    const curve = new Float32Array(200);
    expect(isNeutral(notes, params, curve)).toBe(true);
    curve[50] = 1;
    curve[100] = 1; // unvoiced
    expect(isNeutral(notes, params, curve)).toBe(false);
    const s = frameShifts(notes, f0, hop, params, curve);
    expect(s[50]).toBeCloseTo(1, 5);
    expect(s[100]).toBe(0);
  });
});

describe('a bent line is heard', () => {
  const ph = singPhrase([{ midi: 57, dur: 2.4, gap: 0.1 }], SR, 4);
  const a = analyze(ph.audio, SR);
  const notes = segment(a.f0, a.hopSec, a.db);

  function pitchAt(curve: Float32Array, t: number) {
    const shifts = frameShifts(notes, a.f0, a.hopSec, params, curve);
    const last = shifts.length - 1;
    const y = psola(ph.audio, a.marks, (s) => Math.pow(2, shifts[Math.min(last, Math.round(s / SR / a.hopSec))] / 12));
    const b = analyze(y, SR);
    const f = Math.round(t / b.hopSec);
    const v: number[] = [];
    for (let i = f - 6; i <= f + 6; i++) if (b.f0[i] > 0) v.push(hzToMidi(b.f0[i]));
    return v.reduce((s, x) => s + x, 0) / v.length;
  }

  it('moves the pitch under the brush by the dragged amount and nothing else', () => {
    const center = Math.round(1.2 / a.hopSec);
    const curve = new Float32Array(a.f0.length);
    bendCurve(curve, new Float32Array(a.f0.length), a.f0, a.hopSec, center, 0.15, 1.5);
    const flat = new Float32Array(a.f0.length);
    const under = pitchAt(curve, 1.2) - pitchAt(flat, 1.2);
    const far = pitchAt(curve, 2.0) - pitchAt(flat, 2.0);
    console.log('line bent +1.5 st: change under brush', under.toFixed(2), '| far away', far.toFixed(2));
    expect(Math.abs(under - 1.5)).toBeLessThan(0.25);
    expect(Math.abs(far)).toBeLessThan(0.1);
  });
});
