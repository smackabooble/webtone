export interface PitchTrack {
  /** Fundamental frequency per frame in Hz, 0 = unvoiced. */
  f0: Float32Array;
  /** Seconds between frames. */
  hopSec: number;
  /** Loudness per frame (RMS). */
  rms: Float32Array;
}

/**
 * Low-pass (windowed sinc) and downsample by an integer factor. A proper filter matters:
 * content above the new Nyquist would otherwise fold back as inharmonic junk and blur
 * the periodicity pitch detection looks for, especially for high voices.
 */
export function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const half = 4 * factor;
  const taps = new Float32Array(2 * half + 1);
  const fc = 0.45 / factor; // cycles per input sample
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const win = 0.5 + 0.5 * Math.cos((Math.PI * k) / (half + 1));
    taps[k + half] = sinc * win;
    sum += taps[k + half];
  }
  for (let k = 0; k < taps.length; k++) taps[k] /= sum;
  const n = Math.floor(x.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * factor;
    let acc = 0;
    const k0 = Math.max(-half, -c);
    const k1 = Math.min(half, x.length - 1 - c);
    for (let k = k0; k <= k1; k++) acc += taps[k + half] * x[c + k];
    out[i] = acc;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pitch tracking in the style of pYIN (Mauch & Dixon, 2014):
//   1. Per frame, YIN yields several pitch candidates, each with a probability
//      derived from a prior over the YIN threshold (not one fixed threshold).
//   2. A hidden Markov model over pitch bins plus an "unvoiced" state is solved
//      with Viterbi, so the track follows smooth pitch motion and octave jumps
//      or one-frame glitches are rejected.
// ---------------------------------------------------------------------------

const BINS_PER_SEMITONE = 3;
/** How readily a frame is called unvoiced, and how costly voiced/unvoiced switches are. */
const U_SCALE = 0.02;
const P_SWITCH = 0.03;
const MIDI_LO = 33; // ~55 Hz
const MIDI_HI = 90; // ~1.5 kHz
const NBINS = (MIDI_HI - MIDI_LO) * BINS_PER_SEMITONE;
const binToMidi = (b: number) => MIDI_LO + b / BINS_PER_SEMITONE;
const midiToBin = (m: number) => (m - MIDI_LO) * BINS_PER_SEMITONE;

/** Cumulative weights of a Beta(2,12) prior over the YIN threshold 0.01..1.00. */
/** Shape of the prior over the YIN threshold: Beta(2, BETA_B + 1). Higher = stricter about what counts as periodic. */
const BETA_B = 11;
const THRESH_CDF = (() => {
  const w: number[] = [];
  let sum = 0;
  for (let k = 0; k < 100; k++) {
    const s = (k + 0.5) / 100;
    const v = s * Math.pow(1 - s, BETA_B);
    w.push(v);
    sum += v;
  }
  const cdf = new Float64Array(101);
  for (let k = 0; k < 100; k++) cdf[k + 1] = cdf[k] + w[k] / sum;
  return cdf;
})();
const thresholdMass = (v: number) => THRESH_CDF[Math.max(0, Math.min(100, Math.floor(v * 100)))];

interface Candidates {
  /** Fractional MIDI pitch of each candidate. */
  midi: Float32Array;
  prob: Float32Array;
  n: number;
}

/** Turn a CMNDF into pitch candidates with probabilities (pYIN stage 1). */
export function candidatesFromCmnd(
  cmnd: Float32Array,
  sr: number,
  tauMin: number,
  tauMax: number,
): Candidates {
  const mins: number[] = [];
  let globalMin = tauMin;
  for (let t = tauMin; t < tauMax; t++) {
    if (cmnd[t] < cmnd[globalMin]) globalMin = t;
    if (cmnd[t] <= cmnd[t - 1] && cmnd[t] < cmnd[t + 1]) mins.push(t);
  }
  const midi = new Float32Array(6);
  const prob = new Float32Array(6);
  let n = 0;
  const push = (tau: number, p: number) => {
    for (let i = 0; i < n; i++) {
      if (midi[i] === tau) {
        prob[i] += p;
        return;
      }
    }
    if (n < 6) {
      midi[n] = tau;
      prob[n] = p;
      n++;
    }
  };
  // A local minimum is the first one below threshold s for every s between its own
  // value and the lowest value among earlier minima: that range carries its probability.
  let prevMin = 1;
  for (const m of mins) {
    // Depth of the dip between samples: where the period falls off the sample grid the raw
    // value overstates it, which is worst for high voices.
    const da = cmnd[m - 1];
    const db = cmnd[m];
    const dc = cmnd[m + 1];
    const dd = da - 2 * db + dc;
    const v = dd > 0 ? Math.max(0, db - (0.125 * (da - dc) * (da - dc)) / dd) : db;
    if (v < prevMin) {
      const p = thresholdMass(prevMin) - thresholdMass(v);
      if (p > 0) push(m, p);
      prevMin = v;
    }
  }
  // Thresholds below every minimum find nothing; pYIN credits the deepest dip a little.
  if (mins.length) push(globalMin, 0.01 * thresholdMass(cmnd[globalMin]));

  let total = 0;
  for (let i = 0; i < n; i++) {
    const tau = midi[i];
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    midi[i] = 69 + 12 * Math.log2(sr / (tau + shift) / 440);
    total += prob[i];
  }
  if (total > 0.99) for (let i = 0; i < n; i++) prob[i] *= 0.99 / total;
  return { midi, prob, n };
}

/** YIN difference function, cumulative-mean normalised, for one frame. */
export function cmndf(buf: Float32Array, W: number, tauMax: number, out: Float32Array) {
  out[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let j = 0; j < W; j++) {
      const diff = buf[j] - buf[j + tau];
      d += diff * diff;
    }
    running += d;
    out[tau] = running > 0 ? (d * tau) / running : 1;
  }
}

/** Length of the YIN integration window in seconds. */
const WIN_SEC = 0.020;

export function detectPitch(
  x: Float32Array,
  sr: number,
  fmin = 65,
  fmax = 1500,
): PitchTrack {
  const hop = Math.max(1, Math.round(sr * 0.005));
  const W = Math.floor(sr * WIN_SEC);
  const tauMax = Math.floor(sr / fmin);
  const tauMin = Math.max(2, Math.floor(sr / fmax));
  const frameLen = W + tauMax + 2;
  const nFrames = Math.floor(x.length / hop);
  const rms = new Float32Array(nFrames);
  const buf = new Float32Array(frameLen);
  const cmnd = new Float32Array(tauMax + 2);
  const cands: (Candidates | null)[] = new Array(nFrames).fill(null);
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
  }
  const gate = maxRms * 0.015;
  for (let i = 0; i < nFrames; i++) {
    if (rms[i] < Math.max(gate, 1e-5)) continue;
    const start = i * hop - (frameLen >> 1);
    for (let j = 0; j < frameLen; j++) {
      const k = start + j;
      buf[j] = k >= 0 && k < x.length ? x[k] : 0;
    }
    cmndf(buf, W, tauMax, cmnd);
    cands[i] = candidatesFromCmnd(cmnd, sr, tauMin, tauMax);
  }

  const track = viterbiPitch(cands);
  const f0 = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) if (track[i] > 0) f0[i] = 440 * Math.pow(2, (track[i] - 69) / 12);
  return { f0, hopSec: hop / sr, rms };
}

/**
 * pYIN stage 2. States: NBINS voiced pitch bins and one unvoiced state.
 * Voiced -> voiced moves are limited to a few bins per frame (triangular weights);
 * switching between voiced and unvoiced costs a small fixed probability.
 * Returns fractional MIDI pitch per frame, 0 where unvoiced.
 */
export function viterbiPitch(cands: (Candidates | null)[]): Float32Array {
  const T = cands.length;
  const U = NBINS;
  const S = NBINS + 1;
  const REACH = 7;
  const pSwitch = P_SWITCH;
  // Pitch mostly stays in its bin from one 5 ms frame to the next; moving one or two
  // bins (a fast glide) is allowed but costs more the further it goes.
  const kernel = new Float64Array(REACH + 1);
  let kSum = 0;
  for (let d = 0; d <= REACH; d++) {
    kernel[d] = Math.exp(-d / 0.5);
    kSum += d === 0 ? kernel[d] : 2 * kernel[d];
  }
  const lTri = Array.from(kernel, (v) => Math.log((v / kSum) * (1 - pSwitch)));
  const lToU = Math.log(pSwitch);
  const lFromU = Math.log(pSwitch / NBINS);
  const lStayU = Math.log(1 - pSwitch);

  const back = new Int16Array(T * S);
  let prev = new Float64Array(S).fill(-1e9);
  let cur = new Float64Array(S);
  prev[U] = 0;
  const obs = new Float64Array(S);

  for (let t = 0; t < T; t++) {
    const c = cands[t];
    // Observation log-likelihoods.
    if (!c) {
      obs.fill(Math.log(1e-4));
      obs[U] = Math.log(0.95);
    } else {
      let voiced = 0;
      for (let i = 0; i < c.n; i++) voiced += c.prob[i];
      obs[U] = Math.log(Math.max(0.05, 1 - voiced) * U_SCALE);
      for (let b = 0; b < NBINS; b++) {
        let v = 1e-4;
        for (let i = 0; i < c.n; i++) {
          const d = (midiToBin(c.midi[i]) - b) / 1.5;
          if (d > -4 && d < 4) v += c.prob[i] * Math.exp(-0.5 * d * d);
        }
        obs[b] = Math.log(v);
      }
    }
    // Best way into the unvoiced state.
    let bestV = -Infinity;
    let bestVi = 0;
    for (let b = 0; b < NBINS; b++) {
      if (prev[b] > bestV) {
        bestV = prev[b];
        bestVi = b;
      }
    }
    const fromV = bestV + lToU;
    const fromU = prev[U] + lStayU;
    if (fromU >= fromV) {
      cur[U] = fromU + obs[U];
      back[t * S + U] = U;
    } else {
      cur[U] = fromV + obs[U];
      back[t * S + U] = bestVi;
    }
    // Voiced bins.
    const uIn = prev[U] + lFromU;
    for (let b = 0; b < NBINS; b++) {
      let best = uIn;
      let arg = U;
      const lo = Math.max(0, b - REACH);
      const hi = Math.min(NBINS - 1, b + REACH);
      for (let j = lo; j <= hi; j++) {
        const v = prev[j] + lTri[Math.abs(j - b)];
        if (v > best) {
          best = v;
          arg = j;
        }
      }
      cur[b] = best + obs[b];
      back[t * S + b] = arg;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  // Backtrack.
  const out = new Float32Array(T);
  let state = U;
  let bestEnd = prev[U];
  for (let b = 0; b < NBINS; b++) {
    if (prev[b] > bestEnd) {
      bestEnd = prev[b];
      state = b;
    }
  }
  for (let t = T - 1; t >= 0; t--) {
    if (state !== U) {
      // Use the candidate's exact pitch if one sits near the bin; else the bin centre.
      const c = cands[t];
      let m = binToMidi(state);
      if (c) {
        let bestP = 0;
        for (let i = 0; i < c.n; i++) {
          if (Math.abs(midiToBin(c.midi[i]) - state) <= 2.5 && c.prob[i] > bestP) {
            bestP = c.prob[i];
            m = c.midi[i];
          }
        }
      }
      out[t] = m;
    }
    state = back[t * S + state];
  }
  return out;
}

