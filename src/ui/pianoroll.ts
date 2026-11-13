import { hzToMidi, type Note } from '../dsp/segment';

const KEYW = 44;
const RULER = 22;
const BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const CHROMATIC = new Array<boolean>(12).fill(true);
const MAX_SHIFT = 12;

export class PianoRoll {
  notes: Note[] = [];
  f0: Float32Array = new Float32Array(0);
  env: Float32Array = new Float32Array(0);
  hopSec = 0.005;
  duration = 0;
  playhead = 0;
  /** Pitch classes notes snap to; rows outside it are dimmed. */
  scale: boolean[] = CHROMATIC;
  /** Snaps a dragged pitch to an allowed note. */
  snap: (pitch: number) => number = Math.round;

  /** Called before the first change of a drag, so the app can save undo state. */
  onEditStart: () => void = () => {};
  /** Called when an edit is finished. */
  onEdit: () => void = () => {};
  onSeek: (t: number) => void = () => {};

  private g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private pps = 140;
  private rowH = 16;
  private scrollX = 0;
  /** MIDI pitch at the top edge of the note area. */
  private top = 76;
  private selected = -1;
  private drag: { note: Note; y: number; target: number; moved: boolean } | null = null;
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
    canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    const loop = () => {
      if (this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setData(notes: Note[], f0: Float32Array, env: Float32Array, hopSec: number, duration: number) {
    this.notes = notes;
    this.f0 = f0;
    this.env = env;
    this.hopSec = hopSec;
    this.duration = duration;
    this.selected = -1;
    this.scrollX = 0;
    this.playhead = 0;
    this.pps = Math.max(40, Math.min(400, (this.w - KEYW - 20) / Math.max(1, duration)));
    if (notes.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const n of notes) {
        lo = Math.min(lo, n.pitch);
        hi = Math.max(hi, n.pitch);
      }
      this.top = (lo + hi) / 2 + (this.h - RULER) / this.rowH / 2;
    }
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
      const yc = this.yOf(n.pitch + n.shift);
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
      const t = this.tOf(x);
      this.pps = Math.max(20, Math.min(2000, this.pps * Math.exp(-e.deltaY * 0.002)));
      this.scrollX = t * this.pps - (x - KEYW);
    } else if (e.shiftKey) {
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
    this.selected = i;
    if (i >= 0) {
      const note = this.notes[i];
      this.drag = { note, y, target: note.pitch + note.shift, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    } else if (x >= KEYW && this.duration > 0) {
      this.onSeek(Math.max(0, Math.min(this.duration, this.tOf(x))));
    }
    this.invalidate();
  }

  private onMove(e: PointerEvent) {
    const { x, y } = this.pos(e);
    if (!this.drag) {
      this.canvas.style.cursor = this.hit(x, y) >= 0 ? 'ns-resize' : 'default';
      return;
    }
    const d = this.drag;
    let target = d.target + (d.y - y) / this.rowH;
    if (!e.altKey) target = this.snap(target);
    let shift = target - d.note.pitch;
    shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, shift));
    if (shift !== d.note.shift) {
      if (!d.moved) {
        d.moved = true;
        this.onEditStart();
      }
      d.note.shift = shift;
      this.invalidate();
    }
  }

  private onUp(_e: PointerEvent) {
    if (!this.drag) return;
    const moved = this.drag.moved;
    this.drag = null;
    if (moved) this.onEdit();
  }

  private onDblClick(e: MouseEvent) {
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
      const cy = this.yOf(n.pitch + n.shift);
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
      const edited = n.shift !== 0;
      const sel = i === this.selected;
      if (edited) {
        g.strokeStyle = 'rgba(255,170,90,0.5)';
        g.setLineDash([3, 3]);
        g.strokeRect(x0 + 0.5, this.yOf(n.pitch) - rowH / 2 + 1.5, x1 - x0, rowH - 3);
        g.setLineDash([]);
      }
      const y = this.yOf(n.pitch + n.shift) - rowH / 2 + 1;
      g.fillStyle = sel ? 'rgba(255,175,100,0.9)' : edited ? 'rgba(255,160,80,0.72)' : 'rgba(255,165,95,0.5)';
      this.roundRect(x0, y, x1 - x0, rowH - 2, 2);
      g.fill();
      g.lineWidth = sel ? 2 : 1;
      g.strokeStyle = sel ? '#ffe2c2' : 'rgba(255,150,70,0.95)';
      g.stroke();
      g.lineWidth = 1;
    });

    // Pitch curve: brown outline with an orange core. Continuous, runs between notes.
    const noteOf = new Int32Array(this.f0.length).fill(-1);
    this.notes.forEach((n, i) => noteOf.fill(i, n.start, n.end));
    const fA = Math.max(0, Math.floor(this.tOf(KEYW) / this.hopSec) - 1);
    const fB = Math.min(this.f0.length, Math.ceil(t1 / this.hopSec) + 1);
    const maxGap = Math.round(0.4 / this.hopSec);
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
      const ni = noteOf[f];
      const px = this.xOf(f * this.hopSec);
      const py = this.yOf(hzToMidi(hz) + (ni >= 0 ? this.notes[ni].shift : 0));
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
