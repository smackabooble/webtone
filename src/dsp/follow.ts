/**
 * Making a sung melody follow a MIDI melody: pick one note at a time from the MIDI, line it up
 * in time with what was sung, and say which MIDI note each sung note should become.
 * Everything here is in seconds and works on plain {start, end, pitch} spans.
 */

export interface Span {
  start: number;
  end: number;
  pitch: number;
}

export type ChordMode = 'highest' | 'lowest' | 'closest';

/** Notes that start within this many seconds of each other count as starting together (a chord). */
export const CHORD_WINDOW = 0.03;

/**
 * Reduce MIDI to one note at a time. Where several notes start together, one is kept: the
 * highest, the lowest, or the one closest to what the singer was singing (`voiceAt` gives the sung
 * pitch at a MIDI time, or null). A held note stops when the next one begins.
 */
export function toMelody(notes: Span[], mode: ChordMode, voiceAt?: (t: number) => number | null): Span[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch);
  const picks: Span[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].start - sorted[i].start <= CHORD_WINDOW) j++;
    const group = sorted.slice(i, j).sort((a, b) => b.pitch - a.pitch); // highest first
    let pick = group[0];
    if (mode === 'lowest') pick = group[group.length - 1];
    else if (mode === 'closest') {
      const voice = voiceAt?.(group[0].start + 0.05) ?? null;
      if (voice !== null) pick = group.reduce((best, n) => (Math.abs(n.pitch - voice) < Math.abs(best.pitch - voice) ? n : best));
    }
    picks.push({ ...pick, start: group[0].start });
    i = j;
  }
  for (let k = 0; k + 1 < picks.length; k++) if (picks[k].end > picks[k + 1].start) picks[k].end = picks[k + 1].start;
  return picks.filter((n) => n.end - n.start > 0.005);
}

const FRAME = 0.02;

/** Distance between two pitches ignoring octaves, in semitones (0 to 6). */
export function pitchClassDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

/** Pitch of the spans at every FRAME seconds from time 0 (NaN where nothing sounds). */
function sample(spans: Span[], length: number): Float32Array {
  const out = new Float32Array(length).fill(NaN);
  for (const s of spans) {
    const a = Math.max(0, Math.round(s.start / FRAME));
    const b = Math.min(length, Math.round(s.end / FRAME));
    for (let f = a; f < b; f++) out[f] = s.pitch;
  }
  return out;
}

/**
 * How far later the MIDI has to be moved to line up with the sung notes. At each shift it counts how
 * many sung and MIDI frames agree on the pitch *relative to one fixed key difference*: the MIDI may be
 * in another key (or octave) to the singing, so the best constant difference is searched for too.
 * Positive result = the MIDI starts later than the singing and must be moved later.
 */
export function alignOffset(
  sung: Span[],
  melody: Span[],
  maxShift = 8,
): { offset: number; score: number } {
  if (!sung.length || !melody.length) return { offset: 0, score: 0 };
  const end = Math.max(...sung.map((s) => s.end), ...melody.map((m) => m.end + maxShift)) + 1;
  const F = Math.ceil(end / FRAME);
  const s = sample(sung, F);
  const m = sample(melody, F);
  const K = Math.round(maxShift / FRAME);
  const hist = new Float64Array(12);
  let best = { offset: 0, score: -Infinity };
  for (let k = -K; k <= K; k++) {
    hist.fill(0);
    let both = 0;
    for (let f = Math.max(0, k); f < F; f++) {
      const sv = s[f];
      if (sv !== sv) continue;
      const mv = m[f - k];
      if (mv !== mv) continue;
      both++;
      // The sung pitch minus the MIDI pitch, folded into one octave and rounded to a semitone.
      hist[((Math.round(sv - mv) % 12) + 12) % 12]++;
    }
    let score = 0;
    if (both) {
      let top = 0;
      for (let d = 0; d < 12; d++) {
        const near = hist[d] + 0.5 * (hist[(d + 11) % 12] + hist[(d + 1) % 12]);
        const inside = hist[d] + hist[(d + 11) % 12] + hist[(d + 1) % 12];
        top = Math.max(top, near - 0.35 * (both - inside));
      }
      score = top + 0.15 * both;
    }
    // Prefer the smaller shift when two fit equally well.
    score -= Math.abs(k) * 1e-4;
    if (score > best.score) best = { offset: k * FRAME, score };
  }
  return best;
}

/**
 * The whole octaves (in semitones) to move the MIDI so it sits where the voice is, so that the
 * voice moves as little as possible. Without this a melody written an octave above the singer
 * would drag the voice up an octave.
 */
export function octaveFor(sung: Span[], melody: Span[], offset: number): number {
  const F = Math.ceil(Math.max(...sung.map((s) => s.end), ...melody.map((m) => m.end + offset), 1) / FRAME) + 1;
  const s = sample(sung, F);
  const m = sample(melody.map((n) => ({ ...n, start: n.start + offset, end: n.end + offset })), F);
  const diffs: number[] = [];
  for (let f = 0; f < F; f++) if (s[f] === s[f] && m[f] === m[f]) diffs.push(s[f] - m[f]);
  if (!diffs.length) return 0;
  diffs.sort((a, b) => a - b);
  return Math.round(diffs[diffs.length >> 1] / 12) * 12 + 0; // + 0 turns -0 into 0
}

/**
 * Which track of a MIDI file is the tune being sung, and how far to move it in time. The track whose
 * notes agree best with the singing wins. When several agree about equally (the same tune on more
 * than one instrument, or harmonies in the same rhythm) the highest one is taken, since the tune is
 * normally the top line; the octave is sorted out separately.
 */
export function bestTrack(sung: Span[], tracks: Span[][]): { track: number; offset: number; score: number } {
  const found = tracks.map((melody, track) => {
    const { offset, score } = alignOffset(sung, melody);
    const mean = melody.reduce((sum, n) => sum + n.pitch, 0) / Math.max(1, melody.length);
    return { track, offset, score, mean };
  });
  const top = Math.max(...found.map((f) => f.score));
  const near = found.filter((f) => f.score >= top - Math.abs(top) * 0.08);
  near.sort((a, b) => b.mean - a.mean || b.score - a.score);
  return { track: near[0].track, offset: near[0].offset, score: near[0].score };
}

/** Seconds of overlap between two spans. */
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * The MIDI pitch each sung note should become: the MIDI note it overlaps most (after moving the MIDI
 * by `offset` seconds and `transpose` semitones), or null if it overlaps none to speak of.
 */
export function assignTargets(sung: Span[], melody: Span[], offset: number, transpose: number): (number | null)[] {
  return sung.map((note) => {
    let best: Span | null = null;
    let bestOverlap = 0;
    for (const m of melody) {
      const o = overlap(note, { start: m.start + offset, end: m.end + offset });
      if (o > bestOverlap) {
        bestOverlap = o;
        best = m;
      }
    }
    const needed = Math.min(0.04, 0.3 * (note.end - note.start));
    return best && bestOverlap >= needed ? best.pitch + transpose : null;
  });
}

/**
 * Times inside a sung note where the MIDI moves to a different note, so a note held across two MIDI
 * notes can be cut in two. Each part must be long enough to be a note of its own.
 */
export function splitPoints(note: Span, melody: Span[], offset: number, minPart = 0.07): number[] {
  const inside = melody
    .map((m) => ({ ...m, start: m.start + offset, end: m.end + offset }))
    .filter((m) => overlap(note, m) >= minPart)
    .sort((a, b) => a.start - b.start);
  const points: number[] = [];
  for (let i = 1; i < inside.length; i++) {
    const at = inside[i].start;
    const previous = points.length ? points[points.length - 1] : note.start;
    if (at - previous >= minPart && note.end - at >= minPart && Math.abs(inside[i].pitch - inside[i - 1].pitch) >= 1) points.push(at);
  }
  return points;
}
