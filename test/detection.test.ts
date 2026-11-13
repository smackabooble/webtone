import { describe, expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { hzToMidi, segment } from '../src/dsp/segment';
import { PHRASES, scoreNotes, singPhrase } from './synth';

const SR = 44100;

function detect(name: string) {
  const ph = singPhrase(PHRASES[name], SR, 7);
  const a = analyze(ph.audio, SR);
  const notes = segment(a.f0, a.hopSec, a.db);
  const det = notes.map((n) => ({ start: n.start * a.hopSec, pitch: n.pitch }));
  return { ph, a, det, score: scoreNotes(ph.truth, det) };
}

describe('note detection on synthetic singing', () => {
  for (const name of Object.keys(PHRASES)) {
    it(`${name}: finds the right notes`, () => {
      const { score } = detect(name);
      console.log(name, JSON.stringify(score));
      expect(score.f1).toBeGreaterThanOrEqual(0.85);
      expect(score.pitchErr).toBeLessThan(0.2);
    });
  }

  it('pitch track: few octave errors and accurate within notes', () => {
    let frames = 0;
    let octave = 0;
    let errSum = 0;
    for (const name of Object.keys(PHRASES)) {
      const { ph, a } = detect(name);
      for (let i = 0; i < a.f0.length; i++) {
        const s = Math.round(i * a.hopSec * SR);
        const truth = ph.f0[s];
        const inside = ph.truth.some(
          (t) => s / SR > t.start + 0.12 && s / SR < t.end - 0.06,
        );
        if (!truth || !inside) continue;
        frames++;
        const err = Math.abs(hzToMidi(a.f0[i] || 1) - hzToMidi(truth));
        if (!(a.f0[i] > 0) || err > 6) octave++;
        else errSum += err;
      }
    }
    console.log('pitch frames', frames, 'bad', octave, 'mean err st', errSum / (frames - octave));
    expect(octave / frames).toBeLessThan(0.02);
    expect(errSum / (frames - octave)).toBeLessThan(0.1);
  });
});

describe('robustness', () => {
  const variants: { name: string; seed: number; transpose: number; noise: number }[] = [];
  for (const seed of [1, 2, 3, 4, 5]) variants.push({ name: `seed ${seed}`, seed, transpose: 0, noise: 0 });
  variants.push({ name: 'low voice (-12)', seed: 11, transpose: -12, noise: 0 });
  variants.push({ name: 'high voice (+12)', seed: 12, transpose: 12, noise: 0 });
  variants.push({ name: 'noisy (~25 dB SNR)', seed: 13, transpose: 0, noise: 0.025 });
  variants.push({ name: 'noisy low (~25 dB SNR)', seed: 14, transpose: -7, noise: 0.025 });

  it('keeps a high score across voices, seeds and noise', () => {
    let sum = 0;
    let n = 0;
    const lines: string[] = [];
    for (const v of variants) {
      for (const name of Object.keys(PHRASES)) {
        const notes = PHRASES[name].map((x) => ({ ...x, midi: x.midi + v.transpose }));
        const ph = singPhrase(notes, SR, v.seed);
        if (v.noise) {
          let s = 12345 + v.seed;
          for (let i = 0; i < ph.audio.length; i++) {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            ph.audio[i] += v.noise * ((s / 4294967296) * 2 - 1);
          }
        }
        const a = analyze(ph.audio, SR);
        const det = segment(a.f0, a.hopSec, a.db).map((x) => ({ start: x.start * a.hopSec, pitch: x.pitch }));
        const sc = scoreNotes(ph.truth, det);
        sum += sc.f1;
        n++;
        if (sc.f1 < 0.99) lines.push(`${v.name} / ${name}: f1=${sc.f1.toFixed(2)} (${sc.detected} found, ${sc.truth} true)`);
      }
    }
    console.log('mean F1', (sum / n).toFixed(3), '\n' + lines.join('\n'));
    expect(sum / n).toBeGreaterThanOrEqual(0.92);
  });

  it('analyses a minute of audio in reasonable time', () => {
    const parts: Float32Array[] = [];
    for (let i = 0; i < 8; i++) parts.push(singPhrase(PHRASES.legato, SR, 20 + i).audio);
    const len = parts.reduce((s, p) => s + p.length, 0);
    const x = new Float32Array(len);
    let o = 0;
    for (const p of parts) {
      x.set(p, o);
      o += p.length;
    }
    const t0 = performance.now();
    const a = analyze(x, SR);
    const notes = segment(a.f0, a.hopSec, a.db);
    const ms = performance.now() - t0;
    console.log(`analysed ${(len / SR).toFixed(0)} s of audio in ${(ms / 1000).toFixed(1)} s, ${notes.length} notes`);
    expect(ms).toBeLessThan(((len / SR) * 1000) / 2); // faster than half real time
    // 64 sung; a one-semitone legato step is allowed to merge now and then.
    expect(notes.length).toBeGreaterThanOrEqual(62);
    expect(notes.length).toBeLessThanOrEqual(66);
  });
});

describe('pitches between the grid', () => {
  // Real singers are rarely exactly in tune: every note is a bit sharp or flat. (Offsets keep
  // legato steps at a semitone or more; two joined notes less than that apart can't be told apart.)
  const offsets = [0.35, -0.3, -0.3, 0.3, 0.3, 0.3, -0.3, -0.3];
  for (const seed of [5, 6, 7, 8]) {
    it(`out-of-tune legato, seed ${seed}`, () => {
      const notes = PHRASES.legato.map((n, i) => ({ ...n, midi: n.midi + offsets[i] }));
      const ph = singPhrase(notes, SR, seed);
      const a = analyze(ph.audio, SR);
      const det = segment(a.f0, a.hopSec, a.db).map((x) => ({ start: x.start * a.hopSec, pitch: x.pitch }));
      const sc = scoreNotes(ph.truth, det);
      console.log(`seed ${seed}`, JSON.stringify(sc));
      expect(sc.detected).toBe(8);
      expect(sc.f1).toBeGreaterThanOrEqual(0.99);
    });
  }
});
