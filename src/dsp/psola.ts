/**
 * Place pitch marks one period apart through voiced audio (and at a fixed
 * spacing through unvoiced audio). Each step is nudged to the lag that best
 * matches the previous period, which absorbs small pitch-tracking errors.
 */
export function findMarks(
  x: Float32Array,
  sr: number,
  f0: Float32Array,
  hopSec: number,
): Int32Array {
  const n = x.length;
  const marks: number[] = [];
  const unvoicedStep = Math.max(1, Math.round(sr * 0.005));
  const framesPerSample = 1 / (sr * hopSec);
  let t = 0;

  while (t < n) {
    marks.push(t);
    const frame = Math.min(f0.length - 1, Math.round(t * framesPerSample));
    const f = frame >= 0 ? f0[frame] : 0;
    if (!(f > 0)) {
      t += unvoicedStep;
      continue;
    }
    const T = sr / f;
    const next = Math.round(t + T);
    const w = Math.round(T);
    const range = Math.max(1, Math.round(T * 0.1));
    let bestD = 0;
    if (next + range + w < n) {
      let best = -Infinity;
      for (let d = -range; d <= range; d++) {
        let corr = 0;
        let energy = 1e-12;
        const o = next + d;
        for (let k = 0; k < w; k++) {
          const v = x[o + k];
          corr += x[t + k] * v;
          energy += v * v;
        }
        const score = corr / Math.sqrt(energy);
        if (score > best) {
          best = score;
          bestD = d;
        }
      }
    }
    t = Math.max(t + 1, next + bestD);
  }
  return Int32Array.from(marks);
}

/**
 * TD-PSOLA pitch shift. Two-period grains centred on the analysis marks are
 * overlap-added at a new spacing (period / ratio). Duration is unchanged.
 * `ratioAt(sample)` gives the pitch ratio at a source position; where it is 1
 * the output is an exact copy of the input.
 */
export function psola(
  x: Float32Array,
  marks: Int32Array,
  ratioAt: (sample: number) => number,
): Float32Array<ArrayBuffer> {
  const n = x.length;
  const out = new Float32Array(n);
  const norm = new Float32Array(n);
  const M = marks.length;
  if (M < 2) return x.slice();

  let i = 0;
  let ts = marks[0];
  while (ts < n) {
    while (i + 1 < M && Math.abs(marks[i + 1] - ts) <= Math.abs(marks[i] - ts)) i++;
    const m = marks[i];
    const L = i > 0 ? m - marks[i - 1] : marks[1] - marks[0];
    const isLast = i + 1 >= M;
    // The last grain keeps its tail at full level so the ending is not faded.
    const R = isLast ? Math.max(1, n - m) : marks[i + 1] - m;
    const c = Math.round(ts);

    for (let k = -L + 1; k < 0; k++) {
      const dst = c + k;
      const src = m + k;
      if (dst < 0 || dst >= n || src < 0) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * k) / L));
      out[dst] += w * x[src];
      norm[dst] += w;
    }
    for (let k = 0; k < R; k++) {
      const dst = c + k;
      const src = m + k;
      if (dst < 0 || dst >= n || src >= n) continue;
      const w = isLast ? 1 : 0.5 * (1 + Math.cos((Math.PI * k) / R));
      out[dst] += w * x[src];
      norm[dst] += w;
    }

    const r = ratioAt(m);
    ts += R / (r > 0 ? r : 1);
  }

  // Denser grains (pitch up) would get louder; bring them back to unity.
  for (let j = 0; j < n; j++) if (norm[j] > 1) out[j] /= norm[j];
  return out;
}
