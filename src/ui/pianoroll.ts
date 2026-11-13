import { hzToMidi, type Note } from '../dsp/segment';

const KEYW = 44;
const RULER = 22;
const BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const CHROMATIC = new Array<boolean>(12).fill(true);
const MAX_SHIFT = 12;

export class PianoRoll {
  notes: Note[] = [];
  f0: Float32Array = new Float32Array(0);
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

  setData(notes: Note[], f0: Float32Array, hopSec: number, duration: number) {
    this.notes = notes;
    this.f0 = f0;
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

    // Background: teal slate, like the original.
    const bg = g.createLinearGradient(0, RULER, 0, h);
    bg.addColorStop(0, '#2f5160');
    bg.addColorStop(1, '#274552');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    // Pitch rows: dark for black keys (or notes outside the scale), thin line between rows.
    const full = this.scale.every(Boolean);
    const pHi = Math.ceil(this.top) + 1;
    const pLo = Math.floor(this.top - (h - RULER) / rowH) - 1;
    for (let p = pLo; p <= pHi; p++) {
      const y = this.yOf(p) - rowH / 2;
      const pc = ((p % 12) + 12) % 12;
      if (full ? BLACK[pc] : !this.scale[pc]) {
        g.fillStyle = 'rgba(8,22,30,0.32)';
        g.fillRect(KEYW, y, w - KEYW, rowH);
      }
      g.fillStyle = pc === 0 ? 'rgba(190,225,240,0.38)' : 'rgba(150,200,220,0.14)';
      g.fillRect(KEYW, Math.round(y + rowH) - 0.5, w - KEYW, 1);
    }

    // Time grid: strong line per step, faint subdivisions.
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find((s) => s * this.pps >= 70) ?? 60;
    const t0 = Math.floor(this.tOf(KEYW) / step) * step;
    const t1 = this.tOf(w);
    for (let t = Math.max(0, t0); t <= t1 + step; t += step) {
      for (let k = 0; k < 4; k++) {
        g.fillStyle = k === 0 ? 'rgba(190,225,240,0.28)' : 'rgba(150,200,220,0.09)';
        g.fillRect(Math.round(this.xOf(t + (k * step) / 4)) - 0.5, RULER, 1, h - RULER);
      }
    }

    g.save();
    g.beginPath();
    g.rect(KEYW, RULER, w - KEYW, h - RULER);
    g.clip();

    // Notes: pale blue blobs, orange once edited.
    this.notes.forEach((n, i) => {
      const x0 = this.xOf(n.start * this.hopSec);
      const x1 = this.xOf(n.end * this.hopSec);
      if (x1 < KEYW || x0 > w) return;
      const edited = n.shift !== 0;
      const sel = i === this.selected;
      if (edited) {
        g.strokeStyle = 'rgba(200,230,245,0.45)';
        g.setLineDash([3, 3]);
        this.roundRect(x0, this.yOf(n.pitch) - rowH / 2 + 1, x1 - x0, rowH - 2, 5);
        g.stroke();
        g.setLineDash([]);
      }
      const y = this.yOf(n.pitch + n.shift) - rowH / 2 + 1;
      const grad = g.createLinearGradient(0, y, 0, y + rowH - 2);
      if (edited) {
        grad.addColorStop(0, sel ? '#ffc178' : '#f6a04e');
        grad.addColorStop(1, sel ? '#e8862c' : '#d9772a');
      } else {
        grad.addColorStop(0, sel ? '#d8f0fa' : '#b9dcea');
        grad.addColorStop(1, sel ? '#8fc1d6' : '#7fb0c6');
      }
      g.fillStyle = grad;
      this.roundRect(x0, y, x1 - x0, rowH - 2, 5);
      g.fill();
      g.lineWidth = sel ? 2 : 1.2;
      g.strokeStyle = sel ? '#ffffff' : edited ? '#8a4a14' : '#1d3a47';
      g.stroke();
      g.lineWidth = 1;
    });

    // Pitch curve over everything, red-orange. Frames in a note follow its edit.
    const noteOf = new Int32Array(this.f0.length).fill(-1);
    this.notes.forEach((n, i) => noteOf.fill(i, n.start, n.end));
    const fA = Math.max(0, Math.floor(this.tOf(KEYW) / this.hopSec) - 1);
    const fB = Math.min(this.f0.length, Math.ceil(t1 / this.hopSec) + 1);
    g.lineJoin = 'round';
    g.strokeStyle = '#ee4b2b';
    g.lineWidth = 1.6;
    g.beginPath();
    let pen = false;
    for (let f = fA; f < fB; f++) {
      const hz = this.f0[f];
      if (!(hz > 0)) {
        pen = false;
        continue;
      }
      const ni = noteOf[f];
      const shift = ni >= 0 ? this.notes[ni].shift : 0;
      const px = this.xOf(f * this.hopSec);
      const py = this.yOf(hzToMidi(hz) + shift);
      if (pen) g.lineTo(px, py);
      else g.moveTo(px, py);
      pen = true;
    }
    g.stroke();
    g.lineWidth = 1;

    // Playhead.
    const px = Math.round(this.xOf(this.playhead)) - 0.5;
    g.fillStyle = '#ffb02e';
    g.fillRect(px, RULER, 1.5, h - RULER);
    g.restore();

    // Ruler.
    g.fillStyle = '#1b2f3a';
    g.fillRect(0, 0, w, RULER);
    g.fillStyle = '#9fbfcc';
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
      g.fillStyle = '#ffb02e';
      g.beginPath();
      g.moveTo(hx - 5, RULER - 8);
      g.lineTo(hx + 6, RULER - 8);
      g.lineTo(hx + 0.5, RULER);
      g.closePath();
      g.fill();
    }

    // Piano keys.
    g.fillStyle = '#10222b';
    g.fillRect(0, RULER, KEYW, h - RULER);
    g.save();
    g.beginPath();
    g.rect(0, RULER, KEYW, h - RULER);
    g.clip();
    g.textAlign = 'right';
    for (let p = pLo; p <= pHi; p++) {
      const pc = ((p % 12) + 12) % 12;
      const y = this.yOf(p) - rowH / 2;
      const black = BLACK[pc] === 1;
      const inScale = this.scale[pc];
      if (black) {
        g.fillStyle = '#1a2a32';
        g.fillRect(0, y, KEYW, rowH);
        g.fillStyle = inScale ? '#33444d' : '#202f37';
        g.fillRect(0, y + 1, KEYW * 0.62, rowH - 2);
      } else {
        g.fillStyle = inScale ? '#e9eef0' : '#8c979c';
        g.fillRect(0, y, KEYW, rowH);
        g.fillStyle = '#9aa6ab';
        g.fillRect(0, Math.round(y + rowH) - 0.5, KEYW, 1);
      }
      if (pc === 0) {
        g.fillStyle = '#34505c';
        g.font = '10px system-ui, sans-serif';
        g.fillText('C' + (Math.floor(p / 12) - 1), KEYW - 5, y + rowH / 2);
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
