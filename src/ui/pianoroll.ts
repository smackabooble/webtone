import { hzToMidi, type Note } from '../dsp/segment';
import { bendCurve, clearCurve } from '../dsp/curve';

const KEYW = 44;
const RULER = 22;
const BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const CHROMATIC = new Array<boolean>(12).fill(true);
const MAX_SHIFT = 12;

export type Tool = 'select' | 'cut' | 'curve';

export class PianoRoll {
  notes: Note[] = [];
  f0: Float32Array = new Float32Array(0);
  env: Float32Array = new Float32Array(0);
  /** Semitones each frame is shifted by (from the global controls), for drawing the pitch curve. */
  frameShift: Float32Array | null = null;
  /** Hand edits to the pitch line (semitones per frame); the roll changes this directly while dragging. */
  curve: Float32Array = new Float32Array(0);
  /** How wide a stretch of the line the Curve tool bends, in seconds. */
  brushSec = 0.12;
  hopSec = 0.005;
  duration = 0;
  playhead = 0;
  tool: Tool = 'select';
  /** Pitch classes notes snap to; rows outside it are dimmed. */
  scale: boolean[] = CHROMATIC;
  /** Snaps a dragged pitch to an allowed note. */
  snap: (pitch: number) => number = Math.round;
  /** Total shift of a note in semitones: the automatic correction plus the user's edit. */
  shiftOf: (n: Note) => number = (n) => n.shift;

  /** Called before the first change of a drag, so the app can save undo state. */
  onEditStart: () => void = () => {};
  /** Called when an edit is finished. */
  onEdit: () => void = () => {};
  /** Playhead scrubbing: called once on press, on every move, and once on release. */
  onSeekStart: () => void = () => {};
  onSeek: (t: number) => void = () => {};
  onSeekEnd: () => void = () => {};
  onSelect: (index: number) => void = () => {};
  /** Curve tool: the curve changed during a drag, so the line should be redrawn from it. */
  onCurveLive: () => void = () => {};
  /** Cut tool: a note was clicked at this frame. */
  onCut: (index: number, frame: number) => void = () => {};

  private g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private pps = 140;
  private rowH = 16;
  private scrollX = 0;
  /** MIDI pitch at the top edge of the note area. */
  private top = 76;
  private selected = -1;
  private scrubbing = false;
  private curveDrag: { center: number; y: number; base: Float32Array; moved: boolean } | null = null;
  private drag: { index: number; y: number; base: number; start: number; startShift: number; moved: boolean } | null = null;
  private noteOf = new Int32Array(0);
  private hoverX = -1;
  private hoverNote = -1;
  private dirty = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.hoverNote = -1;
      this.invalidate();
    });
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    const loop = () => {
      if (this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  canvasCursor(c: string) {
    this.canvas.style.cursor = c;
  }

  get selectedIndex() {
    return this.selected;
  }

  select(i: number) {
    if (i === this.selected) return;
    this.selected = i;
    this.onSelect(i);
    this.invalidate();
  }

  setData(notes: Note[], f0: Float32Array, env: Float32Array, hopSec: number, duration: number) {
    this.f0 = f0;
    this.env = env;
    this.hopSec = hopSec;
    this.duration = duration;
    this.playhead = 0;
    this.frameShift = null;
    this.setNotes(notes, -1);
    this.fit();
  }

  /** Replace the notes (after an edit that changed their structure) without moving the view. */
  setNotes(notes: Note[], select = this.selected) {
    this.notes = notes;
    this.noteOf = new Int32Array(this.f0.length).fill(-1);
    notes.forEach((n, i) => this.noteOf.fill(i, n.start, Math.min(n.end, this.noteOf.length)));
    this.selected = -1;
    this.select(Math.min(select, notes.length - 1));
    this.invalidate();
  }

  /** Zoom to show the whole take and centre on the notes. */
  fit() {
    this.scrollX = 0;
    this.pps = Math.max(20, Math.min(400, (this.w - KEYW - 20) / Math.max(1, this.duration)));
    if (this.notes.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const n of this.notes) {
        lo = Math.min(lo, n.pitch);
        hi = Math.max(hi, n.pitch);
      }
      this.top = (lo + hi) / 2 + (this.h - RULER) / this.rowH / 2;
    }
    this.clampScroll();
    this.invalidate();
  }

  zoom(factor: number, anchorX = (this.w + KEYW) / 2) {
    const t = this.tOf(anchorX);
    this.pps = Math.max(20, Math.min(2000, this.pps * factor));
    this.scrollX = t * this.pps - (anchorX - KEYW);
    this.clampScroll();
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
  }

  setPlayhead(t: number, follow: boolean) {
    this.playhead = t;
    if (follow) {
      const x = this.xOf(t);
      if (x > this.w - 40 || x < KEYW) {
        this.scrollX = Math.max(0, t * this.pps - 60);
      }
    }
    this.invalidate();
  }

  private xOf(t: number) {
    return KEYW + t * this.pps - this.scrollX;
  }
  private tOf(x: number) {
    return (x - KEYW + this.scrollX) / this.pps;
  }
  private yOf(p: number) {
    return RULER + (this.top - p) * this.rowH;
  }

  private resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.invalidate();
  }

  private clampScroll() {
    const maxX = Math.max(0, this.duration * this.pps - (this.w - KEYW) + 40);
    this.scrollX = Math.max(0, Math.min(maxX, this.scrollX));
    this.top = Math.max(24, Math.min(120, this.top));
  }

  private hit(x: number, y: number): number {
    if (x < KEYW || y < RULER) return -1;
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      const x0 = this.xOf(n.start * this.hopSec);
      const x1 = this.xOf(n.end * this.hopSec);
      const yc = this.yOf(n.pitch + this.shiftOf(n));
      if (x >= x0 && x <= x1 && Math.abs(y - yc) <= this.rowH / 2 + 2) return i;
    }
    return -1;
  }

  private pos(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const { x } = this.pos(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoom(Math.exp(-e.deltaY * 0.002), x);
      return;
    }
    if (e.shiftKey) {
      this.scrollX += e.deltaY || e.deltaX;
    } else {
      this.scrollX += e.deltaX;
      this.top -= e.deltaY / this.rowH / 3;
    }
    this.clampScroll();
    this.invalidate();
  }

  private onDown(e: PointerEvent) {
    const { x, y } = this.pos(e);
    const i = this.hit(x, y);
    this.select(i);
    if (this.tool === 'curve') {
      if (x >= KEYW && y >= RULER && this.f0.length) {
        const center = Math.round(this.tOf(x) / this.hopSec);
        this.curveDrag = { center, y, base: this.curve.slice(), moved: false };
        this.canvas.setPointerCapture(e.pointerId);
      } else if (x >= KEYW && this.duration > 0) {
        this.scrubbing = true;
        this.canvas.setPointerCapture(e.pointerId);
        this.onSeekStart();
        this.scrub(x);
      }
      this.invalidate();
      return;
    }
    if (i >= 0 && this.tool === 'cut') {
      this.onCut(i, Math.round(this.tOf(x) / this.hopSec));
      return;
    }
    if (i >= 0) {
      const note = this.notes[i];
      // Dragging moves the note in absolute pitch; the edit is whatever is needed on top of
      // the automatic correction to land there.
      const base = note.pitch + this.shiftOf(note) - note.shift;
      this.drag = { index: i, y, base, start: base + note.shift, startShift: note.shift, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    } else if (x >= KEYW && this.duration > 0) {
      // Empty space or the ruler: grab the playhead and drag it.
      this.scrubbing = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.onSeekStart();
      this.scrub(x);
    }
    this.invalidate();
  }

  private scrub(x: number) {
    // Nudge the view along when the pointer runs past either edge.
    if (x > this.w - 30) this.scrollX += (x - (this.w - 30)) * 0.6;
    else if (x < KEYW + 30) this.scrollX -= (KEYW + 30 - x) * 0.6;
    this.clampScroll();
    this.onSeek(Math.max(0, Math.min(this.duration, this.tOf(x))));
  }

  private onMove(e: PointerEvent) {
    const { x, y } = this.pos(e);
    if (this.scrubbing) {
      this.scrub(x);
      return;
    }
    if (this.curveDrag) {
      const d = this.curveDrag;
      // Hold Shift to bend a quarter as far for each pixel moved: fine adjustment.
      const dy = ((d.y - y) / this.rowH) * (e.shiftKey ? 0.25 : 1);
      if (!d.moved && Math.abs(dy) > 0.02) {
        d.moved = true;
        this.onEditStart();
      }
      if (d.moved) {
        bendCurve(this.curve, d.base, this.f0, this.hopSec, d.center, this.brushSec, dy);
        this.onCurveLive();
        this.invalidate();
      }
      return;
    }
    if (this.tool === 'curve') {
      this.hoverX = x;
      this.canvas.style.cursor = x >= KEYW && y >= RULER ? 'ns-resize' : y < RULER && x >= KEYW ? 'ew-resize' : 'default';
      this.invalidate();
      return;
    }
    if (!this.drag) {
      const over = this.hit(x, y);
      this.canvas.style.cursor =
        this.tool === 'cut' && over >= 0
          ? 'crosshair'
          : over >= 0
            ? 'ns-resize'
            : y < RULER && x >= KEYW
              ? 'ew-resize'
              : 'default';
      if (this.tool === 'cut' && (over !== this.hoverNote || over >= 0)) this.invalidate();
      this.hoverNote = over;
      this.hoverX = x;
      return;
    }
    const d = this.drag;
    const note = this.notes[d.index];
    let target = d.start + (d.y - y) / this.rowH;
    if (!e.altKey) target = this.snap(target);
    const shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, target - d.base));
    if (shift !== note.shift) {
      if (!d.moved) {
        d.moved = true;
        this.onEditStart();
      }
      note.shift = shift;
      this.invalidate();
    }
  }

  private onUp(_e: PointerEvent) {
    if (this.scrubbing) {
      this.scrubbing = false;
      this.onSeekEnd();
      return;
    }
    if (this.curveDrag) {
      const moved = this.curveDrag.moved;
      this.curveDrag = null;
      if (moved) this.onEdit();
      return;
    }
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    if (moved) this.onEdit();
  }

  private onDblClick(e: MouseEvent) {
    if (this.tool === 'curve') {
      // Double-click straightens out any hand edits under the brush.
      const { x } = this.pos(e);
      const center = Math.round(this.tOf(x) / this.hopSec);
      const before = this.curve.slice();
      if (clearCurve(this.curve, this.hopSec, center, this.brushSec)) {
        const after = this.curve.slice();
        this.curve.set(before);
        this.onEditStart();
        this.curve.set(after);
        this.onCurveLive();
        this.invalidate();
        this.onEdit();
      }
      return;
    }
    if (this.tool === 'cut') return;
    const { x, y } = this.pos(e);
    const i = this.hit(x, y);
    if (i < 0 || this.notes[i].shift === 0) return;
    this.onEditStart();
    this.notes[i].shift = 0;
    this.invalidate();
    this.onEdit();
  }

  private draw() {
    this.dirty = false;
    const g = this.g;
    const { w, h, rowH } = this;
    const dpr = window.devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    g.fillStyle = '#22404f';
    g.fillRect(0, 0, w, h);

    // Pitch rows: darker for black keys (or notes outside the scale).
    const full = this.scale.every(Boolean);
    const pHi = Math.ceil(this.top) + 1;
    const pLo = Math.floor(this.top - (h - RULER) / rowH) - 1;
    for (let p = pLo; p <= pHi; p++) {
      const y = this.yOf(p) - rowH / 2;
      const pc = ((p % 12) + 12) % 12;
      if (full ? BLACK[pc] : !this.scale[pc]) {
        g.fillStyle = 'rgba(10,28,38,0.35)';
        g.fillRect(KEYW, y, w - KEYW, rowH);
      }
      g.fillStyle = pc === 0 ? 'rgba(8,22,30,0.55)' : 'rgba(8,22,30,0.22)';
      g.fillRect(KEYW, Math.round(y + rowH) - 0.5, w - KEYW, 1);
    }

    // Time grid: a dark line per step, faint subdivisions.
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find((s) => s * this.pps >= 70) ?? 60;
    const t0 = Math.floor(this.tOf(KEYW) / step) * step;
    const t1 = this.tOf(w);
    for (let t = Math.max(0, t0); t <= t1 + step; t += step) {
      for (let k = 0; k < 4; k++) {
        g.fillStyle = k === 0 ? 'rgba(8,22,30,0.7)' : 'rgba(8,22,30,0.22)';
        g.fillRect(Math.round(this.xOf(t + (k * step) / 4)) - 0.5, RULER, 1, h - RULER);
      }
    }

    g.save();
    g.beginPath();
    g.rect(KEYW, RULER, w - KEYW, h - RULER);
    g.clip();

    // Loudness blobs: pale blue shape behind each note, as tall as the voice is loud.
    const maxH = rowH * 2.2;
    this.notes.forEach((n) => {
      const a = Math.max(0, n.start - 3);
      const b = Math.min(this.env.length, n.end + 3);
      const x0 = this.xOf(a * this.hopSec);
      const x1 = this.xOf(b * this.hopSec);
      if (x1 < KEYW || x0 > w || b - a < 2) return;
      const cy = this.yOf(n.pitch + this.shiftOf(n));
      g.fillStyle = 'rgba(205,228,245,0.88)';
      g.beginPath();
      for (let f = a; f < b; f++) g.lineTo(this.xOf(f * this.hopSec), cy - this.env[f] * maxH);
      for (let f = b - 1; f >= a; f--) g.lineTo(this.xOf(f * this.hopSec), cy + this.env[f] * maxH);
      g.closePath();
      g.fill();
    });

    // Notes: translucent orange boxes.
    this.notes.forEach((n, i) => {
      const x0 = this.xOf(n.start * this.hopSec);
      const x1 = this.xOf(n.end * this.hopSec);
      if (x1 < KEYW || x0 > w) return;
      const total = this.shiftOf(n);
      const edited = Math.abs(total) > 0.001;
      const sel = i === this.selected;
      if (edited) {
        g.strokeStyle = 'rgba(255,170,90,0.5)';
        g.setLineDash([3, 3]);
        g.strokeRect(x0 + 0.5, this.yOf(n.pitch) - rowH / 2 + 1.5, x1 - x0, rowH - 3);
        g.setLineDash([]);
      }
      const y = this.yOf(n.pitch + total) - rowH / 2 + 1;
      g.fillStyle = sel ? 'rgba(255,175,100,0.9)' : edited ? 'rgba(255,160,80,0.72)' : 'rgba(255,165,95,0.5)';
      this.roundRect(x0, y, x1 - x0, rowH - 2, 2);
      g.fill();
      g.lineWidth = sel ? 2 : 1;
      g.strokeStyle = sel ? '#ffe2c2' : 'rgba(255,150,70,0.95)';
      g.stroke();
      g.lineWidth = 1;
    });

    // Pitch curve: brown outline with an orange core. Continuous, runs between notes.
    const noteOf = this.noteOf;
    const dragged = this.drag && this.drag.moved ? this.drag : null;
    const dragExtra = dragged ? this.notes[dragged.index].shift - dragged.startShift : 0;
    const fA = Math.max(0, Math.floor(this.tOf(KEYW) / this.hopSec) - 1);
    const fB = Math.min(this.f0.length, Math.ceil(t1 / this.hopSec) + 1);
    const maxGap = Math.round(0.12 / this.hopSec);
    const path = new Path2D();
    let pen = false;
    let last = -Infinity;
    let prevX = 0;
    let prevY = 0;
    for (let f = Math.max(0, fA - maxGap); f < fB; f++) {
      const hz = this.f0[f];
      if (!(hz > 0)) continue;
      if (f - last > maxGap) pen = false;
      last = f;
      let shift = this.frameShift ? this.frameShift[f] : 0;
      if (dragged && noteOf[f] === dragged.index) shift += dragExtra;
      const px = this.xOf(f * this.hopSec);
      const py = this.yOf(hzToMidi(hz) + shift);
      if (!pen) path.moveTo(px, py);
      else path.quadraticCurveTo(prevX, prevY, (prevX + px) / 2, (prevY + py) / 2);
      prevX = px;
      prevY = py;
      pen = true;
    }
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = '#6b3510';
    g.lineWidth = 4;
    g.stroke(path);
    g.strokeStyle = '#f59a3c';
    g.lineWidth = 1.8;
    g.stroke(path);
    g.lineWidth = 1;

    // Curve tool: show how wide a stretch of the line a drag will bend.
    if (this.tool === 'curve' && this.hoverX >= KEYW) {
      const half = this.brushSec * this.pps;
      g.fillStyle = 'rgba(255,255,255,0.07)';
      g.fillRect(this.hoverX - half, RULER, half * 2, h - RULER);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(Math.round(this.hoverX) - 0.5, RULER, 1, h - RULER);
    }

    // Cut tool: preview where the slice would fall.
    if (this.tool === 'cut' && this.hoverNote >= 0) {
      const n = this.notes[this.hoverNote];
      const cy = this.yOf(n.pitch + this.shiftOf(n));
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(Math.round(this.hoverX) + 0.5, cy - rowH * 1.4);
      g.lineTo(Math.round(this.hoverX) + 0.5, cy + rowH * 1.4);
      g.stroke();
      g.setLineDash([]);
    }

    // Playhead: thin light line.
    const px = Math.round(this.xOf(this.playhead)) - 0.5;
    g.fillStyle = 'rgba(225,235,240,0.85)';
    g.fillRect(px, RULER, 1, h - RULER);
    g.restore();

    // Ruler.
    g.fillStyle = '#0f2230';
    g.fillRect(0, 0, w, RULER);
    g.fillStyle = '#8fb0be';
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let t = Math.max(0, t0); t <= t1; t += step) {
      const x = this.xOf(t);
      if (x < KEYW) continue;
      g.fillRect(Math.round(x) - 0.5, RULER - 7, 1, 7);
      g.fillText(this.fmtTime(t, step), x + 4, RULER / 2 - 1);
    }
    const hx = this.xOf(this.playhead);
    if (hx >= KEYW) {
      g.fillStyle = '#f59a3c';
      g.beginPath();
      g.moveTo(hx - 7, 2);
      g.lineTo(hx + 8, 2);
      g.lineTo(hx + 0.5, RULER - 2);
      g.closePath();
      g.fill();
    }

    // Piano keys.
    g.save();
    g.beginPath();
    g.rect(0, RULER, KEYW, h - RULER);
    g.clip();
    g.fillStyle = '#16262f';
    g.fillRect(0, RULER, KEYW, h - RULER);
    g.textAlign = 'right';
    for (let p = pLo; p <= pHi; p++) {
      const pc = ((p % 12) + 12) % 12;
      const y = this.yOf(p) - rowH / 2;
      const black = BLACK[pc] === 1;
      const inScale = this.scale[pc];
      if (black) {
        const kg = g.createLinearGradient(0, 0, KEYW, 0);
        kg.addColorStop(0, '#2b3a43');
        kg.addColorStop(1, '#0e171c');
        g.fillStyle = inScale ? kg : '#18232a';
        g.fillRect(0, y + 1, KEYW * 0.62, rowH - 2);
      } else {
        const kg = g.createLinearGradient(0, 0, KEYW, 0);
        kg.addColorStop(0, inScale ? '#f4f7f8' : '#9aa5aa');
        kg.addColorStop(1, inScale ? '#c9d2d6' : '#7d888d');
        g.fillStyle = kg;
        g.fillRect(0, y, KEYW, rowH);
        g.fillStyle = '#7e8b91';
        g.fillRect(0, Math.round(y + rowH) - 0.5, KEYW, 1);
      }
      if (pc === 0) {
        g.fillStyle = '#5d6e76';
        g.font = '11px system-ui, sans-serif';
        g.fillText('C ' + (Math.floor(p / 12) - 1), KEYW - 5, y + rowH / 2);
      }
    }
    g.restore();
    g.fillStyle = '#0b1920';
    g.fillRect(KEYW - 0.5, 0, 1, h);
    g.fillRect(0, RULER - 0.5, w, 1);
  }

  private fmtTime(t: number, step: number) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const sec = step < 1 ? s.toFixed(2) : s.toFixed(0);
    return m > 0 ? `${m}:${sec.padStart(step < 1 ? 5 : 2, '0')}` : `${sec}s`;
  }

  private roundRect(x: number, y: number, w: number, h: number, radius = 4) {
    const g = this.g;
    const r = Math.min(radius, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
}
