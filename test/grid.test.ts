import { describe, expect, it } from 'vitest';
import { barBeat, beatSec, clampBpm, formatTime, gridLines, snapToGrid } from '../src/dsp/grid';

describe('tempo grid', () => {
  it('counts bars and beats from 1', () => {
    expect(barBeat(0, 120)).toEqual({ bar: 1, beat: 1 });
    expect(barBeat(0.5, 120)).toEqual({ bar: 1, beat: 2 }); // one beat = 0.5 s at 120
    expect(barBeat(1.99, 120)).toEqual({ bar: 1, beat: 4 });
    expect(barBeat(2.0, 120)).toEqual({ bar: 2, beat: 1 });
    expect(barBeat(6, 60)).toEqual({ bar: 2, beat: 3 });
  });

  it('changing the tempo moves the beats', () => {
    expect(beatSec(60)).toBe(1);
    expect(beatSec(120)).toBe(0.5);
    expect(barBeat(3, 120)).not.toEqual(barBeat(3, 90));
  });

  it('keeps the tempo in a sensible range', () => {
    expect(clampBpm(5)).toBe(30);
    expect(clampBpm(999)).toBe(300);
    expect(clampBpm(97.46)).toBe(97.5);
    expect(clampBpm(NaN)).toBe(120);
  });

  it('snaps to the nearest step', () => {
    expect(snapToGrid(0.62, 0.25)).toBeCloseTo(0.5, 9);
    expect(snapToGrid(0.64, 0.25)).toBeCloseTo(0.75, 9);
    expect(snapToGrid(0.62, 0)).toBe(0.62);
  });

  it('formats time', () => {
    expect(formatTime(3.254)).toBe('0:03.25');
    expect(formatTime(65.5)).toBe('1:05.50');
    expect(formatTime(-1)).toBe('0:00.00');
  });

  it('draws bars, then beats, then finer lines as you zoom in', () => {
    const far = gridLines(0, 20, 120, 20); // 10 px per beat
    expect(far.every((l) => l.level === 0)).toBe(true);
    const mid = gridLines(0, 4, 120, 60); // 30 px per beat
    expect(mid.some((l) => l.level === 1)).toBe(true);
    expect(mid.some((l) => l.level === 2)).toBe(false);
    const near = gridLines(0, 2, 120, 400); // 200 px per beat
    expect(near.some((l) => l.level === 2)).toBe(true);
  });

  it('puts bar lines exactly one bar apart and numbers them', () => {
    const bars = gridLines(0, 10, 120, 100).filter((l) => l.level === 0);
    expect(bars.map((b) => b.bar)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(bars[1].t - bars[0].t).toBeCloseTo(2, 9);
  });

  it('thins out bar lines when they would be too close together', () => {
    const bars = gridLines(0, 120, 120, 5).filter((l) => l.level === 0);
    expect(bars.length).toBeLessThan(15);
    expect(bars[0].bar).toBe(1);
  });
});
