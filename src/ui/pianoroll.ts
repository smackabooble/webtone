import { hzToMidi, type Note } from '../dsp/segment';

const KEYW = 44;
const RULER = 22;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const MAX_SHIFT = 12;

export class PianoRoll {
  notes: Note[] = [];
  f0: Float32Array = new Float32Array(0);
  hopSec = 0.005;
  duration = 0;
  playhead = 0;

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
    if (!e.altKey) target = Math.round(target);
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
    g.fillStyle = '#191c22';
    g.fillRect(0, 0, w, h);

    // Pitch rows.
    const pHi = Math.ceil(this.top) + 1;
    const pLo = Math.floor(this.top - (h - RULER) / rowH) - 1;
    for (let p = pLo; p <= pHi; p++) {
      const y = this.yOf(p) - rowH / 2;
      const pc = ((p % 12) + 12) % 12;
      if (BLACK[pc]) {
        g.fillStyle = '#14161b';
        g.fillRect(KEYW, y, w - KEYW, rowH);
      }
      g.fillStyle = pc === 0 ? '#343946' : '#22252d';
      g.fillRect(KEYW, Math.round(y + rowH) - 0.5, w - KEYW, 1);
    }

    // Time grid.
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
    const step = steps.find((s) => s * this.pps >= 70) ?? 60;
    const t0 = Math.floor(this.tOf(KEYW) / step) * step;
    const t1 = this.tOf(w);
    g.fillStyle = '#262a33';
    for (let t = Math.max(0, t0); t <= t1; t += step) {
      g.fillRect(Math.round(this.xOf(t)) - 0.5, RULER, 1, h - RULER);
    }

    // Notes.
    g.save();
    g.beginPath();
    g.rect(KEYW, RULER, w - KEYW, h - RULER);
    g.clip();
    this.notes.forEach((n, i) => {
      const x0 = this.xOf(n.start * this.hopSec);
      const x1 = this.xOf(n.end * this.hopSec);
      if (x1 < KEYW || x0 > w) return;
      const edited = n.shift !== 0;
      if (edited) {
        g.strokeStyle = 'rgba(160,170,190,0.35)';
        g.setLineDash([3, 3]);
        this.roundRect(x0, this.yOf(n.pitch) - rowH / 2 + 1, x1 - x0, rowH - 2);
        g.stroke();
        g.setLineDash([]);
      }
      const y = this.yOf(n.pitch + n.shift) - rowH / 2 + 1;
      g.fillStyle = edited ? 'rgba(255,176,64,0.55)' : 'rgba(80,170,255,0.5)';
      this.roundRect(x0, y, x1 - x0, rowH - 2);
      g.fill();
      g.strokeStyle = i === this.selected ? '#ffffff' : edited ? '#ffb040' : '#5cb8ff';
      g.lineWidth = i === this.selected ? 1.5 : 1;
      g.stroke();

      // Pitch curve inside the note.
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1.2;
      g.beginPath();
      let pen = false;
      for (let f = n.start; f < n.end; f++) {
        const hz = this.f0[f];
        if (!(hz > 0)) {
          pen = false;
          continue;
        }
        const px = this.xOf(f * this.hopSec);
        const py = this.yOf(hzToMidi(hz) + n.shift);
        if (pen) g.lineTo(px, py);
        else g.moveTo(px, py);
        pen = true;
      }
      g.stroke();
      g.lineWidth = 1;
    });

    // Playhead.
    const px = Math.round(this.xOf(this.playhead)) - 0.5;
    g.fillStyle = '#ff5c7a';
    g.fillRect(px, RULER, 1.5, h - RULER);
    g.restore();

    // Ruler.
    g.fillStyle = '#1d2027';
    g.fillRect(0, 0, w, RULER);
    g.fillStyle = '#8a91a0';
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let t = Math.max(0, t0); t <= t1; t += step) {
      const x = this.xOf(t);
      if (x < KEYW) continue;
      g.fillText(this.fmtTime(t, step), x + 4, RULER / 2);
    }

    // Key gutter.
    g.fillStyle = '#1d2027';
    g.fillRect(0, RULER, KEYW, h - RULER);
    g.textAlign = 'right';
    for (let p = pLo; p <= pHi; p++) {
      const pc = ((p % 12) + 12) % 12;
      const y = this.yOf(p);
      if (y < RULER + 4) continue;
      g.fillStyle = pc === 0 ? '#d8dce4' : BLACK[pc] ? '#5d6472' : '#8a91a0';
      g.fillText(NAMES[pc] + (Math.floor(p / 12) - 1), KEYW - 6, y);
    }
    g.fillStyle = '#2c303a';
    g.fillRect(KEYW - 0.5, 0, 1, h);
    g.fillRect(0, RULER - 0.5, w, 1);
  }

  private fmtTime(t: number, step: number) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const sec = step < 1 ? s.toFixed(2) : s.toFixed(0);
    return m > 0 ? `${m}:${sec.padStart(step < 1 ? 5 : 2, '0')}` : `${sec}s`;
  }

  private roundRect(x: number, y: number, w: number, h: number) {
    const g = this.g;
    const r = Math.min(4, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
}
