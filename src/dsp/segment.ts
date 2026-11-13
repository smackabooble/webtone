export interface Note {
  /** First frame (inclusive). */
  start: number;
  /** Last frame (exclusive). */
  end: number;
  /** Detected centre pitch as a fractional MIDI note. */
  pitch: number;
  /** User edit in semitones, added on top of any automatic correction. */
  shift: number;
}

export const hzToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

/** Centre pitch of a stretch of frames: the median, ignoring the first bit where a note scoops in. */
export function notePitch(f0: Float32Array, start: number, end: number): number {
  const skip = end - start >= 24 ? Math.min(10, Math.floor((end - start) / 4)) : 0;
  const vals: number[] = [];
  for (let i = start + skip; i < end; i++) if (f0[i] > 0) vals.push(hzToMidi(f0[i]));
  if (!vals.length) for (let i = start; i < end; i++) if (f0[i] > 0) vals.push(hzToMidi(f0[i]));
  if (!vals.length) return 60;
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

// ---------------------------------------------------------------------------
// Note segmentation with a hidden Markov model (the approach used by the Tony /
// pYIN note tracker). Each pitch on a half-semitone grid has two states:
//   attack - a note has just begun; pitch is loose (scoops, glides)
//   stable - the note is sustained; pitch must stay close to the grid pitch
// plus one silence state. Leaving a stable note for another pitch costs more than
// vibrato or drift ever gains, so notes follow what was sung, not every wobble.
// Solved with Viterbi over the whole take.
// ---------------------------------------------------------------------------

const MIDI_LO = 33;
const MIDI_HI = 90;
const STEP = 0.5;
const SIGMA_STABLE = 0.6;
const SIGMA_ATTACK = 2.0;
const TAU = 8; // bins; how quickly the cost of a pitch change grows with the interval

const ln = Math.log;
const L = {
  stayS: ln(0.995),
  sToZ: ln(0.002),
  switchBase: ln(0.003 / 16),
  stayA: ln(0.88),
  aToS: ln(0.115),
  aToZ: ln(0.005),
  stayZ: ln(0.99),
};

function logGauss(q: number, mu: number, sigma: number): number {
  const d = (q - mu) / sigma;
  const p = 0.97 * (Math.exp(-0.5 * d * d) / (sigma * 2.5066)) + 0.03 / 40;
  return Math.log(p);
}

/** Split frames into notes (start/end only; pitch is filled in later). */
function hmmNotes(f0: Float32Array): [number, number][] {
  const T = f0.length;
  const K = Math.round((MIDI_HI - MIDI_LO) / STEP);
  const Z = 2 * K;
  const NS = 2 * K + 1;
  const lZtoA = ln(0.01 / K);
  const mu = new Float64Array(K);
  for (let k = 0; k < K; k++) mu[k] = MIDI_LO + k * STEP;

  const back = new Int16Array(T * NS);
  let prev = new Float64Array(NS).fill(-1e9);
  let cur = new Float64Array(NS);
  prev[Z] = 0;
  const lenA = new Float64Array(K);
  const argA = new Int16Array(K);
  const lenR = new Float64Array(K);
  const argR = new Int16Array(K);
  const step = 1 / TAU;

  for (let t = 0; t < T; t++) {
    const voiced = f0[t] > 0;
    const q = voiced ? hzToMidi(f0[t]) : 0;
    const oZ = voiced ? ln(0.02) : ln(0.9);
    const oUnvoicedNote = ln(0.1);

    // Best stable state to switch from, per target pitch: min-plus distance transform.
    for (let k = 0; k < K; k++) {
      const s = prev[K + k];
      if (k > 0 && lenA[k - 1] - step > s) {
        lenA[k] = lenA[k - 1] - step;
        argA[k] = argA[k - 1];
      } else {
        lenA[k] = s;
        argA[k] = k;
      }
    }
    for (let k = K - 1; k >= 0; k--) {
      const s = prev[K + k];
      if (k < K - 1 && lenR[k + 1] - step > s) {
        lenR[k] = lenR[k + 1] - step;
        argR[k] = argR[k + 1];
      } else {
        lenR[k] = s;
        argR[k] = k;
      }
    }

    let bestSv = -Infinity;
    let bestSi = 0;
    let bestAv = -Infinity;
    let bestAi = 0;
    for (let k = 0; k < K; k++) {
      if (prev[K + k] > bestSv) {
        bestSv = prev[K + k];
        bestSi = k;
      }
      if (prev[k] > bestAv) {
        bestAv = prev[k];
        bestAi = k;
      }
    }

    for (let k = 0; k < K; k++) {
      // Attack state k.
      let best = prev[k] + L.stayA;
      let arg = k;
      const fromZ = prev[Z] + lZtoA;
      if (fromZ > best) {
        best = fromZ;
        arg = Z;
      }
      // Switching from a stable note at least a semitone away. A half-semitone move is
      // just drift or vibrato, never a new note, so those sources are left out.
      let sw = -Infinity;
      let swArg = 0;
      if (k > 1) {
        sw = lenA[k - 2] - 2 * step;
        swArg = argA[k - 2];
      }
      if (k < K - 2 && lenR[k + 2] - 2 * step > sw) {
        sw = lenR[k + 2] - 2 * step;
        swArg = argR[k + 2];
      }
      sw += L.switchBase;
      if (sw > best) {
        best = sw;
        arg = K + swArg;
      }
      cur[k] = best + (voiced ? logGauss(q, mu[k], SIGMA_ATTACK) : oUnvoicedNote);
      back[t * NS + k] = arg;

      // Stable state k.
      const stay = prev[K + k] + L.stayS;
      const enter = prev[k] + L.aToS;
      if (stay >= enter) {
        cur[K + k] = stay;
        back[t * NS + K + k] = K + k;
      } else {
        cur[K + k] = enter;
        back[t * NS + K + k] = k;
      }
      cur[K + k] += voiced ? logGauss(q, mu[k], SIGMA_STABLE) : oUnvoicedNote;
    }

    // Silence.
    let bz = prev[Z] + L.stayZ;
    let zArg = Z;
    if (bestSv + L.sToZ > bz) {
      bz = bestSv + L.sToZ;
      zArg = K + bestSi;
    }
    if (bestAv + L.aToZ > bz) {
      bz = bestAv + L.aToZ;
      zArg = bestAi;
    }
    cur[Z] = bz + oZ;
    back[t * NS + Z] = zArg;

    const tmp = prev;
    prev = cur;
    cur = tmp;
  }

  // Backtrack.
  const path = new Int16Array(T);
  let state = Z;
  let bestEnd = prev[Z];
  for (let s = 0; s < Z; s++) {
    if (prev[s] > bestEnd) {
      bestEnd = prev[s];
      state = s;
    }
  }
  for (let t = T - 1; t >= 0; t--) {
    path[t] = state;
    state = back[t * NS + state];
  }

  // A note starts at every attack state that wasn't already in the same attack.
  const out: [number, number][] = [];
  let start = -1;
  for (let t = 0; t <= T; t++) {
    const s = t < T ? path[t] : Z;
    const isZ = s === Z;
    const newNote = !isZ && s < K && (t === 0 || path[t - 1] !== s);
    if (start >= 0 && (isZ || newNote)) {
      out.push([start, t]);
      start = -1;
    }
    if (newNote || (!isZ && start < 0)) start = t;
  }
  return out;
}

const DIP_DB = 8;
const MIN_SPLIT_FRAMES = 8;

/** Split a note where the level dips deeply and comes back: repeated notes and new syllables. */
function splitAtDips(start: number, end: number, db: Float32Array, out: [number, number][]) {
  if (end - start >= 3 * MIN_SPLIT_FRAMES) {
    let m = -1;
    let lowest = Infinity;
    for (let i = start + MIN_SPLIT_FRAMES; i < end - MIN_SPLIT_FRAMES; i++) {
      if (db[i] < lowest) {
        lowest = db[i];
        m = i;
      }
    }
    if (m >= 0) {
      let left = -Infinity;
      let right = -Infinity;
      for (let i = start; i <= m; i++) left = Math.max(left, db[i]);
      for (let i = m; i < end; i++) right = Math.max(right, db[i]);
      if (Math.min(left, right) - lowest >= DIP_DB) {
        splitAtDips(start, m, db, out);
        splitAtDips(m, end, db, out);
        return;
      }
    }
  }
  out.push([start, end]);
}

/** Least-squares slope of the pitch over a stretch of frames, in semitones per second. */
function pitchSlope(f0: Float32Array, start: number, end: number, hopSec: number): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = start; i < end; i++) {
    if (!(f0[i] > 0)) continue;
    const x = (i - start) * hopSec;
    const y = hzToMidi(f0[i]);
    n++;
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const d = n * sxx - sx * sx;
  return n > 2 && d > 0 ? (n * sxy - sx * sy) / d : 0;
}

/**
 * A short stretch that is still gliding towards the note next to it is a scoop into that
 * note (or a fall off its end), not a note of its own. Fold it into the neighbour.
 */
function mergeScoops(spans: [number, number][], f0: Float32Array, hopSec: number): [number, number][] {
  const MAX_FRAMES = Math.round(0.3 / hopSec);
  const out: [number, number][] = [];
  for (let i = 0; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (e - s <= MAX_FRAMES) {
      const here = notePitch(f0, s, e);
      const slope = pitchSlope(f0, s, e, hopSec);
      const next = spans[i + 1];
      if (next && next[0] - e <= 3) {
        const d = notePitch(f0, next[0], next[1]) - here;
        if (Math.abs(d) < 1.5 && slope * Math.sign(d) > 2) {
          spans[i + 1] = [s, next[1]];
          continue;
        }
      }
      const prev = out[out.length - 1];
      if (prev && s - prev[1] <= 3) {
        const d = notePitch(f0, prev[0], prev[1]) - here;
        if (Math.abs(d) < 1.5 && slope * Math.sign(d) > 2) {
          prev[1] = e;
          continue;
        }
      }
    }
    out.push([s, e]);
  }
  return out;
}

/**
 * Turn a pitch track into notes.
 * @param f0 pitch per frame in Hz, 0 where unvoiced
 * @param db loudness per frame relative to the loudest frame, in dB (optional; enables splitting repeated notes)
 */
export function segment(f0: Float32Array, hopSec: number, db?: Float32Array): Note[] {
  const MIN_VOICED = Math.max(4, Math.round(0.06 / hopSec));
  let spans = hmmNotes(f0);

  // Trim unvoiced frames off the edges.
  spans = spans
    .map(([s, e]): [number, number] => {
      while (s < e && !(f0[s] > 0)) s++;
      while (e > s && !(f0[e - 1] > 0)) e--;
      return [s, e];
    })
    .filter(([s, e]) => e > s);

  if (db) {
    const split: [number, number][] = [];
    for (const [s, e] of spans) splitAtDips(s, e, db, split);
    spans = split;
  }

  // Too short to be a sung note: a glide passing through, or a blip. Drop it; if it sat
  // between two legato notes the gap is closed below.
  spans = spans.filter(([s, e]) => {
    let voiced = 0;
    for (let i = s; i < e; i++) if (f0[i] > 0) voiced++;
    return voiced >= MIN_VOICED;
  });

  spans = mergeScoops(spans, f0, hopSec);

  // Legato: when the pitch tracker loses a fast glide between two notes but the voice never
  // dips in level, the singer didn't stop. Let the new note begin where the last one ended.
  if (db) {
    const maxGap = Math.round(0.15 / hopSec);
    for (let i = 1; i < spans.length; i++) {
      const [, pe] = spans[i - 1];
      const [ns, ne] = spans[i];
      if (ns - pe < 2 || ns - pe > maxGap) continue;
      const ref = Math.min(db[pe - 1], db[ns]);
      let dip = 0;
      for (let f = pe; f < ns; f++) dip = Math.max(dip, ref - db[f]);
      if (dip < 6) spans[i] = [pe, ne];
    }
  }

  return spans.map(([s, e]) => ({ start: s, end: e, pitch: notePitch(f0, s, e), shift: 0 }));
}
