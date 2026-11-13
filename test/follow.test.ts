import { describe, expect, it } from 'vitest';
import { alignOffset, assignTargets, bestTrack, octaveFor, splitPoints, toMelody, type Span } from '../src/dsp/follow';

const note = (start: number, end: number, pitch: number): Span => ({ start, end, pitch });
// A made-up tune: C D E G E D C ...
const tune: Span[] = [60, 62, 64, 67, 64, 62, 60, 65, 69, 67].map((p, i) => note(i * 0.5, i * 0.5 + 0.45, p));

describe('picking one note from chords', () => {
  const chord = [note(0, 1, 60), note(0, 1, 64), note(0, 1, 67), note(1, 2, 62), note(1.01, 2, 65)];
  it('keeps the highest note by default', () => {
    expect(toMelody(chord, 'highest').map((n) => n.pitch)).toEqual([67, 65]);
  });
  it('or the lowest', () => {
    expect(toMelody(chord, 'lowest').map((n) => n.pitch)).toEqual([60, 62]);
  });
  it('or the one nearest to the voice', () => {
    expect(toMelody(chord, 'closest', () => 63.6).map((n) => n.pitch)).toEqual([64, 65]); // 65 is 1.4 away, 62 is 1.6
    expect(toMelody(chord, 'closest', () => 66).map((n) => n.pitch)).toEqual([67, 65]);
    // With nothing sung to compare against it falls back to the highest.
    expect(toMelody(chord, 'closest', () => null).map((n) => n.pitch)).toEqual([67, 65]);
  });
  it('treats notes starting a few milliseconds apart as starting together', () => {
    const loose = [note(0, 1, 60), note(0.02, 1, 72)];
    expect(toMelody(loose, 'highest').length).toBe(1);
  });
  it('lets a held note stop when the next one begins', () => {
    const m = toMelody([note(0, 3, 48), note(1, 1.5, 72)], 'highest');
    expect(m.map((n) => [n.pitch, n.start, n.end])).toEqual([
      [48, 0, 1],
      [72, 1, 1.5],
    ]);
  });
});

describe('lining the MIDI up with the singing', () => {
  const sing = (shift: number, transpose = 0, wobble = 0.3) =>
    tune.map((n, i) => note(n.start + shift, n.end + shift, n.pitch + transpose + (i % 2 ? wobble : -wobble)));

  for (const shift of [0.37, -0.8, 2.5]) {
    it(`finds a shift of ${shift} s`, () => {
      const found = alignOffset(sing(shift), tune);
      expect(Math.abs(found.offset - shift)).toBeLessThan(0.05);
    });
  }
  it('is not thrown by the MIDI being in a different key', () => {
    for (const key of [1, 3, 5, 7, 11]) {
      const found = alignOffset(sing(0.9, key), tune);
      expect(Math.abs(found.offset - 0.9)).toBeLessThan(0.05);
    }
  });
  it('is not thrown by the voice being an octave or two away', () => {
    expect(Math.abs(alignOffset(sing(0.6, -12), tune).offset - 0.6)).toBeLessThan(0.05);
    expect(Math.abs(alignOffset(sing(0.6, 24), tune).offset - 0.6)).toBeLessThan(0.05);
  });
  it('copes with a missed note', () => {
    const partial = sing(0.4).filter((_, i) => i !== 3 && i !== 6);
    expect(Math.abs(alignOffset(partial, tune).offset - 0.4)).toBeLessThan(0.05);
  });
  it('finds the octave to move the MIDI by', () => {
    expect(octaveFor(sing(0.2, 0), tune, 0.2)).toBe(0);
    expect(octaveFor(sing(0.2, -12), tune, 0.2)).toBe(-12);
    expect(octaveFor(sing(0.2, 12), tune, 0.2)).toBe(12);
    expect(octaveFor(sing(0.2, -24), tune, 0.2)).toBe(-24);
    // A different key as well as a different octave: move by whichever octave leaves the voice moving least.
    expect(octaveFor(sing(0.2, -9), tune, 0.2)).toBe(-12);
    expect(octaveFor(sing(0.2, 3), tune, 0.2)).toBe(0);
  });
});

describe('which MIDI note each sung note becomes', () => {
  it('uses the MIDI note it overlaps most', () => {
    const sung = [note(0.02, 0.4, 59.7), note(0.52, 0.9, 62.4), note(5, 5.4, 70)];
    expect(assignTargets(sung, tune, 0, 0)).toEqual([60, 62, null]);
  });
  it('applies the time offset and the transposition', () => {
    const sung = [note(1.0, 1.4, 55), note(1.5, 1.9, 56)];
    expect(assignTargets(sung, tune, 1.0, -12)).toEqual([48, 50]);
  });
  it('picks the bigger overlap when a note straddles two', () => {
    expect(assignTargets([note(0.3, 0.95, 61)], tune, 0, 0)).toEqual([62]);
  });
});

describe('cutting a held note where the MIDI changes', () => {
  it('splits where a new MIDI note starts inside it', () => {
    const points = splitPoints(note(0, 1, 61), tune, 0);
    expect(points.length).toBe(1);
    expect(points[0]).toBeCloseTo(0.5, 6);
  });
  it('leaves short remainders alone', () => {
    expect(splitPoints(note(0, 0.52, 61), tune, 0).length).toBe(0);
  });
  it('does not split between two notes of the same pitch', () => {
    const same = [note(0, 0.5, 60), note(0.5, 1, 60.2)];
    expect(splitPoints(note(0, 1, 60), same, 0).length).toBe(0);
  });
});

describe('choosing the track that is being sung', () => {
  const sung = tune.map((n) => note(n.start + 0.4, n.end + 0.4, n.pitch + 0.2));
  const at = (shift: number) => tune.map((n) => note(n.start, n.end, n.pitch + shift));
  // A different rhythm entirely: sustained pads that don't match the singing.
  const pad = [note(0, 2.3, 55), note(2.3, 4.6, 59)];

  it('picks the track that matches, and its time shift', () => {
    const found = bestTrack(sung, [pad, at(0), at(-24)]);
    expect(found.track).not.toBe(0);
    expect(Math.abs(found.offset - 0.4)).toBeLessThan(0.05);
  });
  it('among the same tune at different pitches picks the top line', () => {
    expect(bestTrack(sung, [at(-24), at(0), at(7), at(-12)]).track).toBe(2);
    expect(bestTrack(sung, [at(12), at(-12), at(24)]).track).toBe(2);
  });
});
