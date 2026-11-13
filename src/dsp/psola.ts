/**
 * Place pitch marks one period apart through voiced audio (and at a fixed
 * spacing through unvoiced audio). Each voiced mark is snapped to the waveform
 * peak nearest the predicted spot, so marks sit on the glottal pulses. That is
 * what lets grains overlap cleanly when the pitch is moved.
 */
export function findMarks(
  x: Float32Array,
  sr: number,
  f0: Float32Array,
  hopSec: number,
): Int32Array {
  const n = x.length;
  const unvoicedStep = Math.max(1, Math.round(sr * 0.005));
  const framesPerSample = 1 / (sr * hopSec);
  const freqAt = (t: number) => {
    const f = Math.min(f0.length - 1, Math.round(t * framesPerSample));
    return f >= 0 ? f0[f] : 0;
  };

  // Which sign carries the stronger peaks? Marks follow that one consistently.
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < f0.length; i++) {
    if (!(f0[i] > 0)) continue;
    const t0 = Math.round(i / framesPerSample);
    const T = Math.round(sr / f0[i]);
    let hi = 0;
    let lo = 0;
    for (let k = t0; k < Math.min(n, t0 + T); k++) {
      if (x[k] > hi) hi = x[k];
      if (x[k] < lo) lo = x[k];
    }
    pos += hi;
    neg -= lo;
  }
  const pol = pos >= neg ? 1 : -1;

  const marks: number[] = [];
  let t = 0;
  while (t < n) {
    marks.push(t);
    const f = freqAt(t);
    if (!(f > 0)) {
      t += unvoicedStep;
      continue;
    }
    const T = sr / f;
    const pred = Math.round(t + T);
    const range = Math.max(1, Math.round(T * 0.25));
    let best = -Infinity;
    let bt = pred;
    for (let k = pred - range; k <= pred + range; k++) {
      if (k <= t || k >= n - 1) continue;
      const v = pol * (x[k - 1] + 2 * x[k] + x[k + 1]);
      if (v > best) {
        best = v;
        bt = k;
      }
    }
    t = Math.max(t + 1, bt);
  }
  return Int32Array.from(marks);
}

/**
 * TD-PSOLA pitch shift. Two-period grains centred on the analysis marks are
 * overlap-added at a new spacing (period / ratio). Duration is unchanged unless `speed` is given,
 * which stretches or squeezes time without touching pitch.
 * `ratioAt(sample)` gives the pitch ratio at a source position; where it is 1
 * the output is an exact copy of the input.
 */
export function psola(
  x: Float32Array,
  marks: Int32Array,
  ratioAt: (sample: number) => number,
  speed = 1,
): Float32Array<ArrayBuffer> {
  const n = x.length;
  // speed > 1 plays faster (shorter); speed < 1 slower (longer). Pitch is not affected by it.
  const nOut = Math.max(1, Math.round(n / speed));
  const out = new Float32Array(nOut);
  const norm = new Float32Array(nOut);
  const M = marks.length;
  if (M < 2) {
    if (speed === 1) return x.slice();
    for (let j = 0; j < nOut; j++) out[j] = x[Math.min(n - 1, Math.round(j * speed))];
    return out;
  }

  let i = 0;
  let ts = marks[0] / speed; // where the next grain goes in the output
  while (ts < nOut) {
    // Which source grain belongs at this output time: the mark nearest the matching source time.
    // Faster playback skips some grains, slower playback uses some twice; spacing is unchanged.
    const src = ts * speed;
    while (i + 1 < M && Math.abs(marks[i + 1] - src) <= Math.abs(marks[i] - src)) i++;
    const m = marks[i];
    const L = i > 0 ? m - marks[i - 1] : marks[1] - marks[0];
    const isLast = i + 1 >= M;
    // The last grain keeps its tail at full level so the ending is not faded.
    const R = isLast ? Math.max(1, n - m) : marks[i + 1] - m;
    const c = Math.round(ts);

    for (let k = -L + 1; k < 0; k++) {
      const dst = c + k;
      const from = m + k;
      if (dst < 0 || dst >= nOut || from < 0) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * k) / L));
      out[dst] += w * x[from];
      norm[dst] += w;
    }
    for (let k = 0; k < R; k++) {
      const dst = c + k;
      const from = m + k;
      if (dst < 0 || dst >= nOut || from >= n) continue;
      const w = isLast ? 1 : 0.5 * (1 + Math.cos((Math.PI * k) / R));
      out[dst] += w * x[from];
      norm[dst] += w;
    }

    const r = ratioAt(m);
    ts += R / (r > 0 ? r : 1);
  }

  // Grains overlap more (pitch up) or less (pitch down) than the source did, so
  // the window sum drifts away from 1. Divide it out to keep the level steady.
  for (let j = 0; j < nOut; j++) if (norm[j] > 1e-3) out[j] /= norm[j];
  return out;
}
