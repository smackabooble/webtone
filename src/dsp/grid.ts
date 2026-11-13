/** Tempo grid: bars and beats counted from the start of the audio, in 4/4. */

export const BEATS_PER_BAR = 4;
export const MIN_BPM = 30;
export const MAX_BPM = 300;

export const beatSec = (bpm: number) => 60 / bpm;

export function clampBpm(v: number): number {
  if (!Number.isFinite(v)) return 120;
  return Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, v)) * 10) / 10;
}

/** Bar and beat (both counted from 1) at a time. */
export function barBeat(t: number, bpm: number): { bar: number; beat: number } {
  const beats = Math.max(0, t) / beatSec(bpm);
  return {
    bar: Math.floor(beats / BEATS_PER_BAR) + 1,
    beat: Math.floor(beats % BEATS_PER_BAR) + 1,
  };
}

/** Round a time to the nearest multiple of a step (seconds). */
export const snapToGrid = (t: number, stepSec: number) => (stepSec > 0 ? Math.round(t / stepSec) * stepSec : t);

/** 3.25 seconds -> "0:03.25" */
export function formatTime(t: number): string {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

export interface GridLine {
  t: number;
  /** 0 = bar line, 1 = beat, 2 = subdivision */
  level: 0 | 1 | 2;
  /** Bar number, for level 0 lines. */
  bar?: number;
}

/**
 * The lines to draw between two times. How fine the grid gets depends on how far apart the
 * beats are on screen: zoomed out you only see bars (every 2nd, 4th... bar when very small),
 * zoomed in you also get beats, half beats and quarter beats.
 */
export function gridLines(t0: number, t1: number, bpm: number, pps: number): GridLine[] {
  const beat = beatSec(bpm);
  const pxBeat = pps * beat;
  const pxBar = pxBeat * BEATS_PER_BAR;
  const sub = pxBeat >= 140 ? 4 : pxBeat >= 70 ? 2 : 1;
  const showBeats = pxBeat >= 14;
  // When bars themselves get tiny, only draw every N bars.
  let every = 1;
  while (pxBar * every < 44) every *= 2;

  const step = beat / sub;
  const out: GridLine[] = [];
  const first = Math.max(0, Math.floor(t0 / step));
  const last = Math.ceil(t1 / step);
  for (let i = first; i <= last; i++) {
    const perBar = BEATS_PER_BAR * sub;
    if (i % perBar === 0) {
      const bar = i / perBar + 1;
      if ((bar - 1) % every === 0) out.push({ t: i * step, level: 0, bar });
    } else if (showBeats && i % sub === 0) out.push({ t: i * step, level: 1 });
    else if (showBeats && sub > 1) out.push({ t: i * step, level: 2 });
  }
  return out;
}
