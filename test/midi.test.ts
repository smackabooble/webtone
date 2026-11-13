import { describe, expect, it } from 'vitest';
import { parseMidi } from '../src/dsp/midi';

// --- a tiny MIDI file writer, just for the tests ---
const vlq = (n: number) => {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
};
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
type Ev = { tick: number; bytes: number[] };
function track(events: Ev[], name?: string) {
  const body: number[] = [];
  if (name) body.push(0, 0xff, 0x03, name.length, ...ascii(name));
  let last = 0;
  for (const e of [...events].sort((a, b) => a.tick - b.tick)) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  return [...ascii('MTrk'), ...u32(body.length), ...body];
}
const on = (tick: number, pitch: number, vel = 90, ch = 0): Ev => ({ tick, bytes: [0x90 | ch, pitch, vel] });
const off = (tick: number, pitch: number, ch = 0): Ev => ({ tick, bytes: [0x80 | ch, pitch, 0] });
const tempo = (tick: number, bpm: number): Ev => {
  const us = Math.round(60e6 / bpm);
  return { tick, bytes: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] };
};
const file = (tracks: number[][], ppq = 480, format = 1) =>
  new Uint8Array([...ascii('MThd'), ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(ppq), ...tracks.flat()]);

describe('MIDI reader', () => {
  it('reads notes and puts them in seconds at 120 BPM', () => {
    const f = parseMidi(file([track([tempo(0, 120), on(0, 60), off(480, 60), on(480, 62), off(960, 62)], 'Melody')]));
    expect(f.tracks.length).toBe(1);
    expect(f.tracks[0].name).toBe('Melody');
    expect(f.notes.map((n) => [n.pitch, n.start, n.end])).toEqual([
      [60, 0, 0.5],
      [62, 0.5, 1],
    ]);
  });

  it('follows tempo changes', () => {
    // 120 BPM for the first beat, then 60 BPM.
    const f = parseMidi(file([track([tempo(0, 120), tempo(480, 60), on(0, 60), off(480, 60), on(480, 64), off(960, 64)])]));
    expect(f.notes[0].end).toBeCloseTo(0.5, 6);
    expect(f.notes[1].start).toBeCloseTo(0.5, 6);
    expect(f.notes[1].end).toBeCloseTo(1.5, 6); // a beat at 60 BPM is a second
  });

  it('understands running status and note-on with zero velocity as note-off', () => {
    const body = [0, 0x90, 60, 90, 120, 62, 90, /* running status */ 120, 60, 0, 0, 62, 0, 0, 0xff, 0x2f, 0];
    const f = parseMidi(new Uint8Array([...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(480), ...ascii('MTrk'), ...u32(body.length), ...body]));
    expect(f.notes.map((n) => n.pitch)).toEqual([60, 62]);
    expect(f.notes[0].end).toBeGreaterThan(f.notes[0].start);
  });

  it('leaves out drums and keeps tracks separate', () => {
    const f = parseMidi(
      file([
        track([tempo(0, 120), on(0, 36, 100, 9), off(100, 36, 9)], 'Drums only'),
        track([on(0, 72), off(480, 72)], 'Lead'),
        track([on(0, 48), off(960, 48)], 'Bass'),
      ]),
    );
    expect(f.tracks.map((t) => t.name)).toEqual(['Lead', 'Bass']);
    expect(f.notes.every((n) => n.pitch !== 36)).toBe(true);
    expect(f.notes[0].track).toBeLessThan(2);
  });

  it('skips system exclusive and other chunks', () => {
    const body = [0, 0xf0, 3, 1, 2, 0xf7, 0, 0x90, 65, 80, 100, 0x80, 65, 0, 0, 0xff, 0x2f, 0];
    const f = parseMidi(
      new Uint8Array([...ascii('MThd'), ...u32(6), ...u16(0), ...u16(2), ...u16(96), ...ascii('XXXX'), ...u32(2), 1, 2, ...ascii('MTrk'), ...u32(body.length), ...body]),
    );
    expect(f.notes.length).toBe(1);
    expect(f.notes[0].pitch).toBe(65);
  });

  it('gives a clear error for things that are not MIDI', () => {
    expect(() => parseMidi(new Uint8Array(ascii('RIFF....WAVEfmt ')))).toThrow(/MIDI/);
    expect(() => parseMidi(file([track([tempo(0, 120)])]))).toThrow(/no notes/);
    expect(() => parseMidi(new Uint8Array([...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(0x8000 | 25)]))).toThrow(/SMPTE/);
  });
});
