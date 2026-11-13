/** A small Standard MIDI File reader: just the notes, and when they sound in seconds. */

export interface MidiNote {
  /** Seconds from the start of the file, using the file's own tempo changes. */
  start: number;
  end: number;
  /** MIDI note number, 60 = middle C. */
  pitch: number;
  velocity: number;
  track: number;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
}

export interface MidiFile {
  name: string;
  tracks: MidiTrack[];
  /** Every note from every track, sorted by start. */
  notes: MidiNote[];
  duration: number;
}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  get left() {
    return this.b.length - this.pos;
  }
  u8() {
    if (this.pos >= this.b.length) throw new Error('This MIDI file ends too early.');
    return this.b[this.pos++];
  }
  u16() {
    return (this.u8() << 8) | this.u8();
  }
  u32() {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }
  vlq() {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.u8();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('This MIDI file has a bad time value.');
  }
  text(n: number) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

interface RawNote {
  startTick: number;
  endTick: number;
  pitch: number;
  velocity: number;
  channel: number;
}

/** Read the notes of a Standard MIDI File (format 0, 1 or 2). Drums (channel 10) are left out. */
export function parseMidi(data: ArrayBuffer | Uint8Array, name = 'MIDI file'): MidiFile {
  const r = new Reader(data instanceof Uint8Array ? data : new Uint8Array(data));
  if (r.text(4) !== 'MThd') throw new Error("That doesn't look like a MIDI file.");
  const headerLen = r.u32();
  r.u16(); // format: every format is read the same way here
  const trackCount = r.u16();
  const division = r.u16();
  if (division & 0x8000) throw new Error('MIDI files timed in SMPTE frames are not supported.');
  const ppq = division;
  if (!ppq) throw new Error('This MIDI file has no timing.');
  r.pos += Math.max(0, headerLen - 6);

  const tempos: { tick: number; usPerQuarter: number }[] = [];
  const rawTracks: { name: string; notes: RawNote[]; endTick: number }[] = [];

  for (let t = 0; t < trackCount && r.left >= 8; t++) {
    const id = r.text(4);
    const len = r.u32();
    const end = Math.min(r.b.length, r.pos + len);
    if (id !== 'MTrk') {
      r.pos = end;
      t--; // not a track: skip it without counting it
      continue;
    }
    const track = { name: '', notes: [] as RawNote[], endTick: 0 };
    const active = new Map<number, RawNote[]>(); // channel * 128 + pitch -> started notes
    let tick = 0;
    let status = 0;
    while (r.pos < end) {
      tick += r.vlq();
      const byte = r.u8();
      const hasStatus = (byte & 0x80) !== 0;
      if (hasStatus) status = byte;
      else if (!status) throw new Error('This MIDI file is damaged.');

      if (status === 0xff) {
        // Meta event: type, length, data.
        const type = r.u8();
        const n = r.vlq();
        if (type === 0x51 && n === 3) tempos.push({ tick, usPerQuarter: (r.u8() << 16) | (r.u8() << 8) | r.u8() });
        else if (type === 0x03) track.name = r.text(n).trim();
        else r.pos += n;
        if (type === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        r.pos += r.vlq(); // system exclusive: skip it
      } else {
        const kind = status & 0xf0;
        const channel = status & 0x0f;
        // Running status: a data byte with no status byte reuses the last status.
        const d1 = hasStatus ? r.u8() : byte;
        if (kind === 0xc0 || kind === 0xd0) continue; // program change, channel pressure: one data byte
        const d2 = r.u8();
        if (kind === 0x90 && d2 > 0) {
          const note: RawNote = { startTick: tick, endTick: -1, pitch: d1, velocity: d2, channel };
          const key = channel * 128 + d1;
          const list = active.get(key) ?? [];
          list.push(note);
          active.set(key, list);
          track.notes.push(note);
        } else if (kind === 0x80 || kind === 0x90) {
          const note = active.get(channel * 128 + d1)?.shift();
          if (note) note.endTick = tick;
        }
      }
    }
    track.endTick = tick;
    for (const n of track.notes) if (n.endTick < 0) n.endTick = Math.max(tick, n.startTick + 1);
    rawTracks.push(track);
    r.pos = end;
  }

  // Tempo map: seconds at each tempo change.
  tempos.sort((a, b) => a.tick - b.tick);
  const map: { tick: number; sec: number; usPerQuarter: number }[] = [{ tick: 0, sec: 0, usPerQuarter: 500000 }];
  for (const t of tempos) {
    const prev = map[map.length - 1];
    if (t.tick === prev.tick) {
      prev.usPerQuarter = t.usPerQuarter;
      continue;
    }
    map.push({ tick: t.tick, sec: prev.sec + ((t.tick - prev.tick) * prev.usPerQuarter) / (ppq * 1e6), usPerQuarter: t.usPerQuarter });
  }
  const toSec = (tick: number) => {
    let i = map.length - 1;
    while (i > 0 && map[i].tick > tick) i--;
    return map[i].sec + ((tick - map[i].tick) * map[i].usPerQuarter) / (ppq * 1e6);
  };

  const tracks: MidiTrack[] = [];
  const all: MidiNote[] = [];
  rawTracks.forEach((rt, index) => {
    const notes = rt.notes
      .filter((n) => n.channel !== 9)
      .map((n): MidiNote => ({ start: toSec(n.startTick), end: toSec(n.endTick), pitch: n.pitch, velocity: n.velocity, track: tracks.length }))
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    if (!notes.length) return;
    tracks.push({ name: rt.name || `Track ${index + 1}`, notes });
    all.push(...notes);
  });
  if (!all.length) throw new Error('There are no notes in that MIDI file.');
  all.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  return { name, tracks, notes: all, duration: all.reduce((m, n) => Math.max(m, n.end), 0) };
}
