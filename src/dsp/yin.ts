export interface PitchTrack {
  /** Fundamental frequency per frame in Hz, 0 = unvoiced. */
  f0: Float32Array;
  /** Seconds between frames. */
  hopSec: number;
}

/** Box-filter decimation. Crude, but plenty for pitch detection. */
export function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const n = Math.floor(x.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const b = i * factor;
    for (let k = 0; k < factor; k++) s += x[b + k];
    out[i] = s / factor;
  }
  return out;
}

/** YIN pitch detection (de Cheveigné & Kawahara, 2002). */
export function detectPitch(
  x: Float32Array,
  sr: number,
  fmin = 70,
  fmax = 1000,
  threshold = 0.2,
): PitchTrack {
  const hop = Math.max(1, Math.round(sr * 0.005));
  const W = Math.floor(sr * 0.025);
  const tauMax = Math.floor(sr / fmin);
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const frameLen = W + tauMax;
  const nFrames = Math.floor(x.length / hop);
  const f0 = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);
  const buf = new Float32Array(frameLen);
  const cmnd = new Float32Array(tauMax + 1);
  let maxRms = 0;

  for (let i = 0; i < nFrames; i++) {
    const start = i * hop - (frameLen >> 1);
    let e = 0;
    for (let j = 0; j < frameLen; j++) {
      const k = start + j;
      const v = k >= 0 && k < x.length ? x[k] : 0;
      buf[j] = v;
      e += v * v;
    }
    rms[i] = Math.sqrt(e / frameLen);
    if (rms[i] > maxRms) maxRms = rms[i];
    if (rms[i] < 1e-4) continue;

    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let d = 0;
      for (let j = 0; j < W; j++) {
        const diff = buf[j] - buf[j + tau];
        d += diff * diff;
      }
      running += d;
      cmnd[tau] = running > 0 ? (d * tau) / running : 1;
    }

    let tau = -1;
    for (let t = tauMin; t < tauMax; t++) {
      if (cmnd[t] < threshold) {
        while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) continue;

    // Parabolic interpolation around the dip.
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    f0[i] = sr / (tau + shift);
  }

  // Gate quiet frames relative to the loudest one.
  const gate = maxRms * 0.03;
  for (let i = 0; i < nFrames; i++) if (rms[i] < gate) f0[i] = 0;

  return { f0: medianFilter(f0, 5), hopSec: hop / sr };
}

function medianFilter(x: Float32Array, size: number): Float32Array {
  const out = new Float32Array(x.length);
  const half = size >> 1;
  const win: number[] = [];
  for (let i = 0; i < x.length; i++) {
    win.length = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      win.push(j >= 0 && j < x.length ? x[j] : 0);
    }
    win.sort((p, q) => p - q);
    out[i] = win[half];
  }
  return out;
}
