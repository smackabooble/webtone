/**
 * A rotary knob, like the ones on Newtone. Drag up or down to turn it (hold Shift for fine
 * control), use the wheel or arrow keys, double-click to put it back to its starting value.
 */

export interface KnobOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  /** Longer description for the tooltip. */
  title?: string;
}

const SIZE = 44;
const C = SIZE / 2;
const R = 16;
const START = -135; // degrees from straight up
const END = 135;

function point(deg: number, r = R): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

function arc(from: number, to: number): string {
  if (to - from < 0.5) return '';
  const [x0, y0] = point(from);
  const [x1, y1] = point(to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export class Knob {
  value: number;
  readonly initial: number;
  private fill: SVGPathElement;
  private needle: SVGLineElement;
  private readout: HTMLElement;

  constructor(
    private host: HTMLElement,
    private o: KnobOptions,
  ) {
    this.value = o.value;
    this.initial = o.value;
    host.classList.add('knob');
    host.tabIndex = 0;
    host.setAttribute('role', 'slider');
    host.setAttribute('aria-label', o.label);
    host.setAttribute('aria-valuemin', String(o.min));
    host.setAttribute('aria-valuemax', String(o.max));
    if (o.title) host.title = `${o.title} (drag, wheel or arrow keys; double-click to reset)`;
    host.innerHTML = `
      <svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" aria-hidden="true">
        <path class="knob-track" d="${arc(START, END)}" />
        <path class="knob-fill" d="" />
        <circle class="knob-cap" cx="${C}" cy="${C}" r="11" />
        <line class="knob-needle" x1="${C}" y1="${C}" x2="${C}" y2="${C - 9}" />
      </svg>
      <div class="knob-label">${o.label}</div>
      <div class="knob-value"></div>`;
    this.fill = host.querySelector('.knob-fill')!;
    this.needle = host.querySelector('.knob-needle')!;
    this.readout = host.querySelector('.knob-value')!;
    this.draw();

    let startY = 0;
    let startValue = 0;
    host.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startValue = this.value;
      host.setPointerCapture(e.pointerId);
      host.classList.add('turning');
      host.focus();
      e.preventDefault();
    });
    host.addEventListener('pointermove', (e) => {
      if (!host.hasPointerCapture(e.pointerId)) return;
      const range = o.max - o.min;
      const fine = e.shiftKey ? 0.25 : 1;
      this.set(startValue + ((startY - e.clientY) / 150) * range * fine);
    });
    const end = (e: PointerEvent) => {
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      host.classList.remove('turning');
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('dblclick', () => this.set(this.initial));
    host.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = ((o.max - o.min) / 50) * (e.shiftKey ? 0.25 : 1);
        this.set(this.value + (e.deltaY < 0 ? unit : -unit));
      },
      { passive: false },
    );
    host.addEventListener('keydown', (e) => {
      const step = o.step ?? 1;
      const moves: Record<string, number> = {
        ArrowUp: step,
        ArrowRight: step,
        ArrowDown: -step,
        ArrowLeft: -step,
        PageUp: step * 10,
        PageDown: -step * 10,
      };
      if (e.key in moves) this.set(this.value + moves[e.key]);
      else if (e.key === 'Home') this.set(o.min);
      else if (e.key === 'End') this.set(o.max);
      else return;
      // Arrow keys belong to the knob while it is focused, not to the note editor.
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /** Change the value and tell the app. */
  set(v: number) {
    if (this.setQuiet(v)) this.o.onInput(this.value);
  }

  /** Change the value without telling the app (for resets). Returns true if it changed. */
  setQuiet(v: number): boolean {
    const step = this.o.step ?? 1;
    const next = Math.min(this.o.max, Math.max(this.o.min, Math.round(v / step) * step));
    if (next === this.value) return false;
    this.value = next;
    this.draw();
    return true;
  }

  private draw() {
    const { min, max, format } = this.o;
    const frac = (this.value - min) / (max - min);
    const deg = START + frac * (END - START);
    this.fill.setAttribute('d', arc(START, deg));
    const [x, y] = point(deg, 9);
    this.needle.setAttribute('x2', x.toFixed(2));
    this.needle.setAttribute('y2', y.toFixed(2));
    this.readout.textContent = format(this.value);
    this.host.setAttribute('aria-valuenow', String(this.value));
    this.host.setAttribute('aria-valuetext', format(this.value));
  }
}
