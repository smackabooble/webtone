/** A short, deliberately out-of-tune melody for trying the editor. */
export function makeDemo(sr: number): Float32Array<ArrayBuffer> {
  const pitches = [60.3, 62.4, 63.7, 65.2, 67.4, 65.3, 63.6, 60.2];
  const noteSec = 0.45;
  const gapSec = 0.06;
  const total = Math.ceil((pitches.length * (noteSec + gapSec) + 0.3) * sr);
  const out = new Float32Array(total);
  const fade = 0.02 * sr;
  let pos = Math.round(0.15 * sr);

  for (const p of pitches) {
    const len = Math.round(noteSec * sr);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const vibrato = 0.25 * Math.sin((2 * Math.PI * 5.5 * i) / sr) * Math.min(1, i / (0.15 * sr));
      const f = 440 * Math.pow(2, (p + vibrato - 69) / 12);
      phase += (2 * Math.PI * f) / sr;
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(phase * h) / h;
      const env = Math.min(1, i / fade, (len - i) / fade);
      out[pos + i] = 0.25 * v * env;
    }
    pos += len + Math.round(gapSec * sr);
  }
  return out;
}
