import { describe, expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { psola } from '../src/dsp/psola';
import { hzToMidi } from '../src/dsp/segment';
import { singPhrase } from './synth';

const SR = 44100;

function pitchOf(x: Float32Array, from: number, to: number) {
  const a = analyze(x, SR);
  const v: number[] = [];
  for (let i = Math.round(from / a.hopSec); i < Math.round(to / a.hopSec); i++) if (a.f0[i] > 0) v.push(hzToMidi(a.f0[i]));
  v.sort((p, q) => p - q);
  return { pitch: v[v.length >> 1], share: v.length / (Math.round(to / a.hopSec) - Math.round(from / a.hopSec)) };
}

function level(y: Float32Array, from: number, to: number) {
  const win = Math.round(0.03 * SR);
  let lo = Infinity;
  let hi = 0;
  for (let s = Math.round(from * SR); s + win < Math.round(to * SR); s += win) {
    let e = 0;
    for (let i = 0; i < win; i++) e += y[s + i] * y[s + i];
    lo = Math.min(lo, Math.sqrt(e / win));
    hi = Math.max(hi, Math.sqrt(e / win));
  }
  return hi / lo;
}

describe('time stretching', () => {
  const ph = singPhrase([{ midi: 57, dur: 2.4, gap: 0.2 }], SR, 3);
  const a = analyze(ph.audio, SR);
  const midiIn = pitchOf(ph.audio, 0.6, 1.6).pitch;
  // The source itself wobbles in level (tremolo); stretching shouldn't add much to that.
  const baseSpread = level(ph.audio, 0.6, 1.6);

  it('leaves audio alone at normal speed', () => {
    const y = psola(ph.audio, a.marks, () => 1, 1);
    expect(y.length).toBe(ph.audio.length);
  });

  for (const speed of [0.5, 0.75, 1.25, 2]) {
    it(`speed ${speed}: length scales and pitch, loudness and voicing hold`, () => {
      const y = psola(ph.audio, a.marks, () => 1, speed);
      expect(Math.abs(y.length / (ph.audio.length / speed) - 1)).toBeLessThan(0.001);
      // The middle of the note, in output time.
      const from = 0.6 / speed;
      const to = 1.6 / speed;
      const r = pitchOf(y, from, to);
      console.log(`speed ${speed}: length ${(y.length / SR).toFixed(2)} s, pitch ${r.pitch.toFixed(2)} (was ${midiIn.toFixed(2)}), voiced ${r.share.toFixed(2)}, level spread ${level(y, from, to).toFixed(2)} (source ${baseSpread.toFixed(2)})`);
      expect(Math.abs(r.pitch - midiIn)).toBeLessThan(0.15);
      expect(r.share).toBeGreaterThan(0.85);
      expect(level(y, from, to)).toBeLessThan(baseSpread * 1.35);
    });
  }

  it('can be combined with a pitch shift', () => {
    const y = psola(ph.audio, a.marks, () => Math.pow(2, 3 / 12), 1.5);
    const r = pitchOf(y, 0.6 / 1.5, 1.6 / 1.5);
    expect(Math.abs(r.pitch - (midiIn + 3))).toBeLessThan(0.2);
    expect(Math.abs(y.length / (ph.audio.length / 1.5) - 1)).toBeLessThan(0.001);
  });
});
